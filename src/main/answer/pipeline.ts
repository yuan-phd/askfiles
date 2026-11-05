/**
 * The answer pipeline (docs/plan.md, Answer pipeline): candidates from vector search and the
 * keyword index, fused by reciprocal rank, grouped into sections, reranked with a cross-encoder,
 * selected by the answer scope, then one streamed model call over numbered sources. Upstream
 * stays the document store and vector database; its chat route is not used.
 *
 * Three stages, so the eval can cache the first and sweep the second without the model:
 * retrieve (candidates, fusion, sections, rerank), choose (floor, count, budget), answer.
 */
import type { BrowseDocument, BrowseSection, DocumentRef, KeywordOptions, RankedSection } from '../browse/index.js';
import {
  displayName,
  mentionedDocuments,
  namedFileGroups,
  rewriteFileNames,
  type FileIdentity,
} from '../browse/identifiers.js';
import { citationOrder, claimsOf, CitationStream, parseCitations, type Claim, type Part } from './citations.js';
import { fuse, sectionKey, type FusedSection, type KeywordCandidate, type VectorCandidate } from './fusion.js';
import type { ChatFn } from './ollama-chat.js';
import {
  contextBudget,
  floorOf,
  rerankerOff,
  sectionCap,
  crossDocumentPartsOf,
  type AnswerParams,
  type AnswerScope,
  type RunSettings,
} from './params.js';
import { claimsText, dropHedges } from './hedges.js';
import { enumeratedItems, followUpMessage, isSetQuestion, statedCount } from './enumerate.js';
import {
  buildMessages,
  isNotFound,
  NOT_FOUND_MARKER,
  readVerdict,
  type ChatMessage,
  type PromptSource,
  type Verdict,
} from './prompt.js';
import { withParagraphs, type ParagraphSource } from './paragraphs.js';
import { answerQuoted, isContentsSection, type QuotedStats } from './quoted.js';
import type { Reranker } from './reranker.js';
import { toAnswerSection, type AnswerSection } from './sections.js';
import { selectSections, type Ranked, type Selection } from './select.js';
import { fileSubqueries, type FileSubquery } from './subquery.js';
import { headingBonus, headingMatcher } from './heading-bonus.js';
import { dropBacktickedFileNames, namePhrases, stripNames } from './file-names.js';
import { extractTerms, isMainlyCjk, type Term } from './terms.js';
import { verifyClaims, type VerifyStats } from './verify.js';

/** A vector-search result as the upstream route returns it. */
export interface RawVectorHit {
  id?: string;
  text?: string;
  metadata?: { url?: string; title?: string };
  score?: number;
}

/** The parts of the browse index the pipeline reads (BrowseIndex). */
export interface SectionIndex {
  sectionTotal(): number;
  sectionFrequency(term: string, o?: KeywordOptions): number;
  rankSections(terms: string[], limit: number, o?: KeywordOptions): RankedSection[];
  section(documentId: string, sectionIndex: number): { document: BrowseDocument; section: BrowseSection } | null;
  getDocument(ref: DocumentRef): BrowseDocument | null;
  /** Names of each file for documentAffinity; absent in indexes built without them. */
  identities?(): FileIdentity[];
}

/** A source with its section filled in, as the watcher's resolveSources returns it. */
export interface Located {
  url?: string | null;
  title?: string | null;
  sectionIndex?: number | null;
}

export interface PipelineDeps {
  vectorSearch(question: string, topK: number, signal?: AbortSignal): Promise<RawVectorHit[]>;
  /** Maps vector chunks to their sections by text (src/main/watcher/sources.ts). */
  resolveSources<T extends { url: string | null; title: string | null; text: string }>(
    sources: T[],
  ): Promise<(T & Located)[]> | (T & Located)[];
  index: SectionIndex;
  /** Null when no reranker is installed: every question then takes the bypass path. */
  reranker: Reranker | null;
  chat: ChatFn;
  log?: (msg: string) => void;
  /** Paragraph embeddings of long sections, for paragraphSelection; absent until built. */
  paragraphs?: ParagraphSource | null;
}

/** Upstream prepends a metadata block to some chunk texts (src/renderer/api/client.js parseHeader). */
function chunkBody(text: string): string {
  return text.replace(/^\s*<document_metadata>[\s\S]*?<\/document_metadata>\s*/, '').trim();
}

export interface Retrieval {
  question: string;
  terms: Term[];
  vector: (VectorCandidate & { file: string | null })[];
  keyword: KeywordCandidate[];
  fused: FusedSection[];
  /** The candidate sections in fused order, texts cut to the section cap. */
  candidates: AnswerSection[];
  /** Rerank score per candidate, null when bypassed. */
  rerank: (number | null)[];
  bypass: boolean;
  bypassReason: string | null;
  timings: { vectorMs: number; keywordMs: number; rerankMs: number };
  /** documentAffinity: the documents the question names; absent when the switch is off. */
  affinity?: { documentIds: string[]; files: string[] };
  /**
   * crossDocument: the question names two or more file groups; the files in the order the question
   * names them, and with the quota part the section keys taken as each file's top sections.
   */
  crossDocument?: {
    documentIds: string[];
    files: string[];
    quota: string[];
    /** perFileSubquery: the query each named file was searched with inside it. */
    subqueries?: FileSubquery[];
  };
}

/** crossDocument: sections of each named file taken from the fused list (round A2). */
export const CROSS_DOCUMENT_QUOTA = 3;

/** Section keys of each named document's best fused sections, in fused order. */
export function quotaSections(fused: FusedSection[], documentIds: string[], per = CROSS_DOCUMENT_QUOTA): string[] {
  const docOf = (k: string) => k.slice(0, k.lastIndexOf('#'));
  const left = new Map(documentIds.map((d) => [d, per]));
  const out: string[] = [];
  for (const f of fused) {
    const n = left.get(docOf(f.key));
    if (!n) continue;
    out.push(f.key);
    left.set(docOf(f.key), n - 1);
  }
  return out;
}

/**
 * fileScopedQuota: chunks fetched by one library-wide vector search before they are filtered to
 * the named files. Upstream's vector search takes no file filter, and its LanceDB search is exact
 * (no approximate index), so with every chunk of the library in the pool the filtered list is the
 * search restricted to the file. 2000 covers the eval corpora (1304 and 693 chunks); in a larger
 * library a file's chunks ranked below the pool are not seen.
 */
export const FILE_SCOPED_VECTOR_POOL = 2000;

/** scopedQuotaV2: sections per named file, and the most sections a question naming several files gets. */
export const SCOPED_V2_QUOTA = 5;
export const SCOPED_V2_MAX_SECTIONS = 8;
/** namedFileQuota8: the same two numbers for a question naming two or more files (round X3). */
export const NAMED_FILE_QUOTA = 8;
export const NAMED_FILE_MAX_SECTIONS = 10;

/**
 * headingPathBonus: the bonus per section key for these terms (heading-bonus.ts), or undefined
 * when the switch is off, so fuse() scores as before.
 */
export function pathBonus(
  terms: Term[],
  p: Pick<AnswerParams, 'headingPathBonus' | 'rrfK'>,
  index: Pick<SectionIndex, 'section'>,
): ((key: string) => number) | undefined {
  if (!p.headingPathBonus || !terms.length) return undefined;
  const matches = headingMatcher(terms);
  const bonus = headingBonus(p.rrfK);
  const seen = new Map<string, number>();
  return (key) => {
    let v = seen.get(key);
    if (v === undefined) {
      const found = index.section(key.slice(0, key.lastIndexOf('#')), Number(key.slice(key.lastIndexOf('#') + 1)));
      v = found && matches(found.section.path) ? bonus : 0;
      seen.set(key, v);
    }
    return v;
  };
}

type VectorHit = VectorCandidate & { file: string | null; documentId: string | null };

/** Upstream hits as candidates of their sections. */
async function vectorCandidates(raw: RawVectorHit[], deps: PipelineDeps, keep?: Set<string>): Promise<VectorHit[]> {
  const chunks = raw.map((r, i) => ({
    id: r.id ?? `chunk-${i}`,
    url: r.metadata?.url ?? null,
    title: r.metadata?.title ?? null,
    text: chunkBody(r.text ?? ''),
    score: typeof r.score === 'number' ? r.score : null,
  }));
  // Filtered by document before the sources are resolved, which maps chunks by their text.
  const wanted = keep
    ? chunks.filter((c) => {
        const d = deps.index.getDocument({ url: c.url, title: c.title });
        return !!d && keep.has(d.id);
      })
    : chunks;
  const located = await deps.resolveSources(wanted);
  return located.map((c) => {
    const doc = deps.index.getDocument({ url: c.url, title: c.title });
    const section = doc && typeof c.sectionIndex === 'number' ? sectionKey(doc.id, c.sectionIndex) : null;
    return {
      id: c.id,
      text: c.text,
      score: c.score,
      section,
      file: doc?.title ?? c.title,
      documentId: doc?.id ?? null,
    };
  });
}

/**
 * Each named document's top sections by retrieval inside it: its chunks of one wide vector search
 * (the first vectorTopK), its sections in the keyword ranking (the first keywordTopK; term weights
 * stay those of the library), fused by RRF. Per document in documentIds order, each in fused order.
 */
export async function fileScopedSections(
  question: string,
  terms: Term[],
  documentIds: string[],
  p: AnswerParams,
  deps: PipelineDeps,
  signal?: AbortSignal,
  o: { per?: number; skipContents?: boolean; queries?: Map<string, string> } = {},
): Promise<FusedSection[]> {
  const per = o.per ?? CROSS_DOCUMENT_QUOTA;
  const ids = new Set(documentIds);
  const stem = { stem: p.keywordStemming };
  // perFileSubquery: a file searched with its own clause; one wide vector search and one keyword
  // ranking per distinct query text, the whole question's shared by every file without a clause.
  const searches = new Map<
    string,
    Promise<{ hits: VectorHit[]; ranking: RankedSection[]; bonus: ((key: string) => number) | undefined }>
  >();
  const search = (query: string) => {
    let s = searches.get(query);
    if (!s) {
      s = (async () => {
        const qTerms =
          query === question
            ? terms
            : extractTerms(query, {
                total: deps.index.sectionTotal(),
                frequency: (t) => deps.index.sectionFrequency(t, stem),
              });
        const hits = await vectorCandidates(await deps.vectorSearch(query, FILE_SCOPED_VECTOR_POOL, signal), deps, ids);
        const ranking = qTerms.length
          ? deps.index.rankSections(
              qTerms.map((t) => t.text),
              deps.index.sectionTotal(),
              stem,
            )
          : [];
        return { hits, ranking, bonus: pathBonus(qTerms, p, deps.index) };
      })();
      searches.set(query, s);
    }
    return s;
  };
  // Inside a file its table of contents holds every heading word, so keyword search ranks it high
  // (round C1); scopedQuotaV2 leaves such sections out of both lists.
  const contents = new Map<string, boolean>();
  const isContents = (docId: string, index: number): boolean => {
    if (!o.skipContents) return false;
    const key = sectionKey(docId, index);
    let v = contents.get(key);
    if (v === undefined) {
      const found = deps.index.section(docId, index);
      v = !!found && isContentsSection(found.section);
      contents.set(key, v);
    }
    return v;
  };
  const out: FusedSection[] = [];
  for (const id of new Set(documentIds)) {
    // Sequential: the searches of one question share Ollama's embedding model anyway.
    const { hits, ranking, bonus } = await search(o.queries?.get(id) ?? question);
    const vector = hits
      .filter((h) => h.documentId === id)
      .filter((h) => !h.section || !isContents(id, Number(h.section.slice(h.section.lastIndexOf('#') + 1))))
      .slice(0, p.vectorTopK);
    const keyword = ranking
      .filter((r) => r.documentId === id && !isContents(id, r.sectionIndex))
      .slice(0, p.keywordTopK)
      .map((r) => ({ section: sectionKey(r.documentId, r.sectionIndex), score: r.score, terms: r.terms }));
    out.push(...fuse(vector, keyword, p.rrfK, bonus).slice(0, per));
  }
  return out;
}

/**
 * Factor on the fused score of a named file's sections. Fused scores are reciprocal ranks with
 * k 60: a section both lists put first scores 2/61, one found by a single list at rank r 1/(60+r).
 * 1.5 lifts a named file's section found by one list at rank 1 (1.5/61) above every other file's
 * single-list section and above one both lists rank about 22 or lower, but not above one both
 * lists rank in their top 10 (2/70): a name in the question favours its file without overruling
 * strong evidence for another.
 */
export const AFFINITY_BOOST = 1.5;

/** Re-sorts the fused sections with the named documents' sections raised by AFFINITY_BOOST. */
export function boostDocuments(fused: FusedSection[], documentIds: Set<string>): FusedSection[] {
  if (!documentIds.size) return fused;
  const docOf = (k: string) => k.slice(0, k.lastIndexOf('#'));
  return fused
    .map((f, i) => ({ f: documentIds.has(docOf(f.key)) ? { ...f, score: f.score * AFFINITY_BOOST } : f, i }))
    .sort((a, b) => b.f.score - a.f.score || a.i - b.i)
    .map((x) => x.f);
}

export async function retrieve(
  question: string,
  s: Pick<RunSettings, 'params' | 'chunkMaxChars'>,
  deps: PipelineDeps,
  signal?: AbortSignal,
): Promise<Retrieval> {
  const p = s.params;
  const t0 = performance.now();
  const vector = (await vectorCandidates(await deps.vectorSearch(question, p.vectorTopK, signal), deps)).map((h) => ({
    id: h.id,
    text: h.text,
    score: h.score,
    section: h.section,
    file: h.file,
  }));
  const t1 = performance.now();

  const stem = { stem: p.keywordStemming };
  const terms = extractTerms(question, {
    total: deps.index.sectionTotal(),
    frequency: (t) => deps.index.sectionFrequency(t, stem),
  });
  const keyword: KeywordCandidate[] = terms.length
    ? deps.index
        .rankSections(
          terms.map((t) => t.text),
          p.keywordTopK,
          stem,
        )
        .map((r) => ({
          section: sectionKey(r.documentId, r.sectionIndex),
          score: r.score,
          terms: r.terms,
        }))
    : [];
  const t2 = performance.now();

  let fused = fuse(vector, keyword, p.rrfK, pathBonus(terms, p, deps.index));
  let affinity: Retrieval['affinity'];
  if (p.documentAffinity) {
    const named = mentionedDocuments(question, deps.index.identities?.() ?? []);
    affinity = { documentIds: named.map((f) => f.documentId), files: named.map((f) => f.file) };
    fused = boostDocuments(fused, new Set(affinity.documentIds));
    if (named.length) deps.log?.(`[answer] affinity: ${affinity.files.join(', ')}`);
  }
  let crossDocument: Retrieval['crossDocument'];
  const parts = crossDocumentPartsOf(p);
  if (parts.size) {
    const groups = namedFileGroups(question, deps.index.identities?.() ?? []);
    if (groups.length >= 2) {
      const files = groups.flat();
      const documentIds = files.map((f) => f.documentId);
      let quota: string[] = [];
      let subqueries: FileSubquery[] | undefined;
      const scopedSearch = p.fileScopedQuota || p.scopedQuotaV2;
      if (parts.has('quota') && scopedSearch) {
        let queries: Map<string, string> | undefined;
        if (p.perFileSubquery) {
          const subs = fileSubqueries(question, groups, deps.index.identities?.() ?? []);
          queries = new Map(subs.map((x) => [x.documentId, x.query]));
          for (const x of subs)
            deps.log?.(
              `[answer] subquery: ${files.find((f) => f.documentId === x.documentId)?.file ?? x.documentId}: ${x.attributed ? x.query : '(whole question)'}`,
            );
          subqueries = subs;
        }
        const scoped = await fileScopedSections(question, terms, documentIds, p, deps, signal, {
          ...(p.scopedQuotaV2
            ? { per: p.namedFileQuota8 ? NAMED_FILE_QUOTA : SCOPED_V2_QUOTA, skipContents: true }
            : {}),
          ...(queries ? { queries } : {}),
        });
        quota = scoped.map((f) => f.key);
        // A section found only inside its file joins the end of the fused list, so it can become a
        // candidate; the library-wide ranks stay as they were.
        const seen = new Set(fused.map((f) => f.key));
        fused = [...fused, ...scoped.filter((f) => !seen.has(f.key))];
      } else if (parts.has('quota')) quota = quotaSections(fused, documentIds);
      crossDocument = {
        documentIds,
        files: files.map((f) => f.file),
        quota,
        ...(subqueries ? { subqueries } : {}),
      };
      deps.log?.(
        `[answer] cross-document: ${crossDocument.files.join(', ')}; ${quota.length} quota sections` +
          (scopedSearch && parts.has('quota') ? (p.scopedQuotaV2 ? ' (file-scoped v2)' : ' (file-scoped)') : ''),
      );
    }
  }
  const cap = sectionCap(p, s.chunkMaxChars);
  const candidates: AnswerSection[] = [];
  const quotaKeys = new Set(crossDocument?.quota ?? []);
  for (const f of fused) {
    // The quota sections of a cross-document question are candidates wherever they rank.
    if (candidates.length >= p.candidateSections) {
      if (!quotaKeys.size) break;
      if (!quotaKeys.has(f.key)) continue;
    }
    const [docId, idx] = [f.key.slice(0, f.key.lastIndexOf('#')), Number(f.key.slice(f.key.lastIndexOf('#') + 1))];
    const found = deps.index.section(docId, idx);
    if (found)
      candidates.push(
        toAnswerSection(found.document, found.section, cap, f.hitTexts, {
          wholeChars: 2 * s.chunkMaxChars,
          terms: f.terms,
        }),
      );
  }

  let bypassReason: string | null = null;
  if (rerankerOff(p)) bypassReason = 'reranker disabled';
  else if (!deps.reranker) bypassReason = 'no reranker installed';
  else if (p.rerankerBypassCjk && isMainlyCjk(question)) bypassReason = 'question is mainly CJK';
  else if (p.rerankerBypassCjk && candidates.some((c) => isMainlyCjk(c.text)))
    bypassReason = 'a candidate section is mainly CJK';
  let rerank: (number | null)[] = candidates.map(() => null);
  if (!bypassReason && candidates.length) {
    rerank = await deps.reranker!.score(
      question,
      candidates.map((c) => `${c.path.join(' > ')}\n${c.text}`),
    );
  }
  const t3 = performance.now();
  return {
    question,
    terms,
    vector,
    keyword,
    fused,
    candidates,
    rerank,
    bypass: bypassReason !== null,
    bypassReason,
    timings: { vectorMs: Math.round(t1 - t0), keywordMs: Math.round(t2 - t1), rerankMs: Math.round(t3 - t2) },
    ...(affinity ? { affinity } : {}),
    ...(crossDocument ? { crossDocument } : {}),
  };
}

/** Candidates in final rank order: by rerank score, or in fused order when bypassed. */
export function ranked(r: Retrieval): Ranked[] {
  // fuse() records the score of a section's best-ranked chunk, which is its highest similarity.
  const vectorOf = new Map(r.fused.map((f) => [f.key, f.vectorScore]));
  const list = r.candidates.map((section, i) => ({
    section,
    rerank: r.rerank[i] ?? null,
    vector: vectorOf.get(section.key) ?? null,
    order: i,
  }));
  if (!r.bypass) list.sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0) || a.order - b.order);
  return list.map(({ section, rerank, vector }) => ({ section, rerank, vector }));
}

export interface ChoiceSettings {
  params: AnswerParams;
  scope: AnswerScope;
  contextLength: number;
}

/**
 * Sections selected for a question that names two or more files (documentAffinity): a cross-file
 * question needs a section of each, and the Balanced count of 5 left one file out (Q04, Q09).
 */
export const AFFINITY_MULTI_SECTIONS = 6;

export function choose(r: Retrieval, s: ChoiceSettings): Selection {
  // A per-question bypass (CJK, model files missing) keeps its old meaning: no floor at all.
  const floorOn = rerankerOff(s.params) ? 'vector' : r.bypass ? 'none' : 'rerank';
  // quoted mode sends extractSections sections to its extraction call, never a table of contents.
  const quoted = s.params.answerMode === 'quoted';
  const list = quoted ? ranked(r).filter((x) => !isContentsSection(x.section)) : ranked(r);
  const multi = s.params.documentAffinity && (r.affinity?.documentIds.length ?? 0) >= 2;
  const quota = new Set(crossDocumentPartsOf(s.params).has('quota') && !quoted ? (r.crossDocument?.quota ?? []) : []);
  if (quota.size) {
    // Each named file's top sections whatever their score, then the overall top sections up to
    // the scope's count; quota first, so the budget drops an overall section before a quota one.
    const floor = floorOf(s.params, s.scope);
    const score = (x: Ranked) => (floorOn === 'vector' ? (x.vector ?? 0) : (x.rerank ?? 0));
    let own = list.filter((x) => quota.has(x.section.key));
    const top = list.filter((x) => floorOn === 'none' || score(x) >= floor).slice(0, s.params.sectionCount[s.scope]);
    const extra = top.filter((x) => !quota.has(x.section.key));
    let count = own.length + extra.length;
    if (s.params.scopedQuotaV2) {
      // Each file's best quota section first, then each file's second and so on, so the cap of
      // SCOPED_V2_MAX_SECTIONS takes the same number from every file before an overall section.
      own = takeInTurn(r.crossDocument?.quota ?? [], own);
      count = Math.min(count, s.params.namedFileQuota8 ? NAMED_FILE_MAX_SECTIONS : SCOPED_V2_MAX_SECTIONS);
    }
    return selectSections([...own, ...extra], {
      count,
      floor: 0,
      budgetTokens: contextBudget(s.params, s.contextLength),
      floorOn: 'none',
    });
  }
  return selectSections(list, {
    count: quoted ? s.params.extractSections : multi ? AFFINITY_MULTI_SECTIONS : s.params.sectionCount[s.scope],
    floor: floorOf(s.params, s.scope),
    budgetTokens: contextBudget(s.params, s.contextLength),
    floorOn,
  });
}

/** The ranked quota sections ordered by their rank inside their file, the files taken in turn. */
export function takeInTurn<T extends { section: { key: string } }>(quota: string[], own: T[]): T[] {
  const docOf = (k: string) => k.slice(0, k.lastIndexOf('#'));
  const byKey = new Map(own.map((x) => [x.section.key, x]));
  const files = new Map<string, T[]>();
  for (const k of quota) {
    const x = byKey.get(k);
    if (!x) continue;
    const list = files.get(docOf(k)) ?? [];
    list.push(x);
    files.set(docOf(k), list);
  }
  const out: T[] = [];
  for (let i = 0; out.length < byKey.size && i < quota.length; i++)
    for (const list of files.values()) if (list[i]) out.push(list[i]!);
  return out;
}

/** A source card's fields, all from the section records, none from the model's text. */
export interface SourceCard {
  /** The number the model cites it by. */
  n: number;
  file: string;
  relPath: string;
  url: string;
  documentId: string;
  sectionIndex: number;
  title: string;
  path: string[];
  pageStart: number | null;
  pageEnd: number | null;
  pageLabel: string | null;
  /** The text the model read. */
  passage: string;
  rerank: number | null;
  trimmed: boolean;
}

export function cardOf(n: number, section: AnswerSection, rerank: number | null, trimmed = false): SourceCard {
  return {
    n,
    file: section.file,
    relPath: section.relPath,
    url: section.url,
    documentId: section.documentId,
    sectionIndex: section.sectionIndex,
    title: section.title,
    path: section.path,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    pageLabel: section.pageLabel,
    passage: section.text,
    rerank,
    trimmed,
  };
}

export interface AnswerResult {
  /** The reply as written, think blocks removed. */
  text: string;
  notFound: boolean;
  claims: Claim[];
  /** Cited sources in order of first citation. */
  cited: SourceCard[];
  /** Selected but not cited. */
  considered: SourceCard[];
  /** For the not-found state: the best reranked sections. */
  nearest: SourceCard[];
  /** For the not-found state: the sources the reply cites as checked, in citation order. */
  checked: SourceCard[];
  /** True when no section passed the floor, so the model was not asked. */
  skippedModel: boolean;
  timings: { firstTokenMs: number | null; modelMs: number };
  stats: { promptTokens: number | null; completionTokens: number | null };
  /** quoted mode only: what the extraction call returned and how much of it was verified. */
  quoted?: QuotedStats;
  /** verifyCitations only: sentences checked, moved and left unsupported. */
  verification?: VerifyStats;
  /** enumerateFollowUp: the question's count, the items the first reply gave, and the follow-up call. */
  followUp?: { wanted: number; given: number; ms: number; added: boolean };
  /** decomposeQuestions: how the question was split, each part's question, outcome and time. */
  split?: { how: 'asks' | 'set'; parts: string[]; notFound: boolean[]; ms: number[] };
  /** dropUnsupportedHedges: the sentences deleted. */
  hedgesDropped?: string[];
  /** The model's reply as written, before any post-processing. */
  rawText?: string;
  /** The question text the model read (questionFileNames rewrites file names in it). */
  questionSent?: string;
  /** verifyStripNames: sentences that had a name taken out for scoring. */
  namesStripped?: number;
  /** dropAnswerFileNames: true when the answer had a backticked file name. */
  fileNamesDropped?: boolean;
}

export type AnswerEvent =
  | { type: 'stage'; stage: 'retrieving' | 'answering' }
  | { type: 'sources'; sources: SourceCard[] }
  | { type: 'delta'; parts: Part[] }
  | { type: 'done'; result: AnswerResult };

/** Sections shown under nothing found. */
export const NEAREST_COUNT = 8;

export type AnswerDeps = Pick<PipelineDeps, 'chat' | 'log'> & Partial<Pick<PipelineDeps, 'index' | 'paragraphs'>>;

/**
 * The section texts the model reads: as selected, or with paragraphSelection the long ones cut
 * to their paragraphs closest to the question. Falls back to the selected text when the
 * paragraphs are not built yet or the embedding call fails.
 */
async function sendTexts(
  question: string,
  r: Retrieval,
  sel: Selection,
  s: Pick<RunSettings, 'params' | 'chunkMaxChars'>,
  deps: AnswerDeps,
  signal?: AbortSignal,
): Promise<AnswerSection[]> {
  const sections = sel.selected.map((x) => x.section);
  if (!s.params.paragraphSelection || !deps.paragraphs || !deps.index || !s.chunkMaxChars) return sections;
  const index = deps.index;
  try {
    const out = await withParagraphs(question, sections, {
      source: deps.paragraphs,
      document: (id) => index.getDocument({ id }),
      terms: r.terms.map((t) => t.text),
      minSectionChars: 2 * s.chunkMaxChars,
      cap: sectionCap(s.params, s.chunkMaxChars),
      signal,
    });
    deps.log?.(`[answer] paragraphs: ${out.replaced} of ${sections.length} sections cut to paragraphs`);
    return out.sections;
  } catch (e) {
    deps.log?.(`[answer] paragraphs skipped: ${(e as Error).message}`);
    return sections;
  }
}

export async function answer(
  question: string,
  r: Retrieval,
  sel: Selection,
  s: Pick<RunSettings, 'params' | 'chatModel' | 'contextLength' | 'temperature'> &
    Partial<Pick<RunSettings, 'chunkMaxChars'>>,
  deps: AnswerDeps,
  emit: (e: AnswerEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<AnswerResult> {
  const nearest = ranked(r)
    .slice(0, NEAREST_COUNT)
    .map((x, i) => cardOf(i + 1, x.section, x.rerank));
  if (s.params.answerMode === 'quoted')
    return answerQuoted(question, r, sel, s, deps, { cardOf, nearest }, emit, signal);
  const sections = await sendTexts(
    question,
    r,
    sel,
    { params: s.params, chunkMaxChars: s.chunkMaxChars ?? 0 },
    deps,
    signal,
  );
  // crossDocument: the question names several files; grouped orders the sources by file.
  const cross = s.params.crossDocument ? r.crossDocument : undefined;
  // grouped and verify belong to crossDocument; crossDocQuota is the quota alone.
  const crossParts = new Set(cross ? s.params.crossDocumentParts : []);
  let picked = sel.selected.map((x, i) => ({ x, section: sections[i]! }));
  if (crossParts.has('grouped')) {
    const rank = (id: string) => {
      const k = cross!.documentIds.indexOf(id);
      return k < 0 ? cross!.documentIds.length : k;
    };
    picked = picked
      .map((y, i) => ({ y, i }))
      .sort((a, b) => rank(a.y.section.documentId) - rank(b.y.section.documentId) || a.i - b.i)
      .map(({ y }) => y);
  }
  const sources = picked.map((y, i) => cardOf(i + 1, y.section, y.x.rerank, y.x.trimmed));
  emit({ type: 'sources', sources });
  const base = {
    claims: [],
    cited: [],
    considered: [],
    nearest,
    checked: [],
    timings: { firstTokenMs: null, modelMs: 0 },
  };
  if (!sources.length) {
    const result: AnswerResult = {
      ...base,
      text: '',
      notFound: true,
      skippedModel: true,
      stats: { promptTokens: null, completionTokens: null },
    };
    emit({ type: 'done', result });
    return result;
  }
  emit({ type: 'stage', stage: 'answering' });
  const verdictLine = s.params.verdictLine;
  const affinity = s.params.documentAffinity;
  const typeOf = new Map((affinity ? (deps.index?.identities?.() ?? []) : []).map((f) => [f.documentId, f.type]));
  const promptSources: PromptSource[] = picked.map(({ section: x }) => ({
    path: x.path,
    text: x.text,
    file: x.file,
    title: x.title,
    type: typeOf.get(x.documentId) ?? '',
    group: cross?.documentIds.includes(x.documentId) ? x.file : '',
    ...(s.params.sourceFileNames || s.params.sourceDisplayNames ? { display: displayName(x.file) } : {}),
  }));
  const enumerate = s.params.enumerateWhenAsked && isSetQuestion(question);
  // questionFileNames: the model reads file names in the question as display name (file name);
  // retrieval already ran on the question as asked.
  const asked = s.params.questionFileNames
    ? rewriteFileNames(
        question,
        (deps.index?.identities?.() ?? []).map((f) => f.file),
      )
    : question;
  if (asked !== question) deps.log?.(`[answer] question file names: ${asked}`);
  const messages = buildMessages(asked, promptSources, s.params.promptVariant, {
    verdictLine,
    fileHeaders: affinity,
    enumerate,
    noSummarizing: s.params.noSummarizing,
    crossDocument: crossParts.has('grouped'),
    grouped: crossParts.has('grouped'),
    fileNames: s.params.sourceFileNames,
    displayNames: s.params.sourceDisplayNames,
  });
  const t0 = performance.now();
  let firstTokenMs: number | null = null;
  let text = '';
  // Nothing is shown while the reply may still turn out to be the not-found marker or verdict.
  let decided = false;
  let verdict: Verdict | null = null;
  const stream = new CitationStream();
  const all: Part[] = [];
  const push = (chunk: string) => {
    const parts = stream.push(chunk);
    all.push(...parts);
    if (parts.length) emit({ type: 'delta', parts });
  };
  const stats = await deps.chat(
    {
      model: s.chatModel,
      messages,
      temperature: s.temperature,
      contextLength: s.contextLength,
      signal,
    },
    (piece) => {
      if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - t0);
      text += piece;
      if (decided) {
        if (verdict !== 'not_found') push(piece);
        return;
      }
      if (verdictLine) {
        const v = readVerdict(text);
        if (!v.complete) return;
        verdict = v.verdict;
        // Without a verdict line the reply goes on through the marker check below.
        if (verdict === 'not_found') return void (decided = true);
        if (verdict === 'found') {
          decided = true;
          if (v.rest) push(v.rest);
          return;
        }
      }
      const t = text.trimStart();
      if (NOT_FOUND_MARKER.startsWith(t) || t.startsWith(NOT_FOUND_MARKER)) return;
      decided = true;
      push(text);
    },
  );
  const modelMs = Math.round(performance.now() - t0);
  if (verdictLine && !decided) verdict = readVerdict(text + '\n').verdict;
  let answerText = verdict === null ? text : readVerdict(text).rest;
  const notFound = verdict === 'not_found' || (verdict === null && isNotFound(text));
  let followUp: AnswerResult['followUp'];
  if (!notFound) {
    if (!decided) push(answerText);
    const wanted = enumerate && s.params.enumerateFollowUp ? statedCount(question) : null;
    if (wanted !== null) {
      const sentences = claimsOf(parseCitations(answerText), sources.length).filter((c) => c.citations.length).length;
      const given = enumeratedItems(answerText, sentences);
      if (given < wanted) {
        const t1 = performance.now();
        const more = await followUpCall(messages, answerText, wanted, given, s, deps, signal);
        if (more) {
          push(`\n\n${more}`);
          answerText = `${answerText.trimEnd()}\n\n${more}`;
        }
        followUp = { wanted, given, ms: Math.round(performance.now() - t1), added: Boolean(more) };
        deps.log?.(
          `[answer] enumerate: ${given} of ${wanted} items, ${more ? 'completed by a follow-up' : 'follow-up added nothing'} in ${followUp.ms} ms`,
        );
      }
    }
    const rest = stream.end();
    all.push(...rest);
    if (rest.length) emit({ type: 'delta', parts: rest });
  }
  let parts = notFound ? [] : all;
  // dropAnswerFileNames: backticked file names out of the answer before it is verified.
  let fileNamesDropped = false;
  if (s.params.dropAnswerFileNames && !notFound) {
    const merged: Part[] = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      if (p.type === 'text' && last?.type === 'text')
        merged[merged.length - 1] = { type: 'text', text: last.text + p.text };
      else merged.push(p);
    }
    parts = merged.map((p) => {
      if (p.type !== 'text') return p;
      const d = dropBacktickedFileNames(p.text);
      fileNamesDropped ||= d.changed;
      return d.changed ? { type: 'text', text: d.text } : p;
    });
    if (fileNamesDropped) {
      answerText = dropBacktickedFileNames(answerText).text;
      deps.log?.('[answer] file names dropped from the answer');
    }
  }
  let claims = notFound ? [] : claimsOf(parts, sources.length);
  let namesStripped = 0;
  let verification: VerifyStats | undefined;
  if (s.params.verifyCitations && claims.length) {
    // A question naming exactly one file may be attributed only to its sources, when any is selected.
    const named = affinity && r.affinity?.documentIds.length === 1 ? r.affinity.documentIds[0] : null;
    const own = named ? sources.filter((c) => c.documentId === named).map((c) => c.n) : [];
    // verifyStripNames: whole display names and backticked file names do not count as overlap.
    const phrases = s.params.verifyStripNames
      ? namePhrases((deps.index?.identities?.() ?? []).map((f) => displayName(f.file)))
      : null;
    const scored = phrases
      ? claims.map((c) => {
          const x = stripNames(c.text, phrases);
          if (x.changed) namesStripped++;
          return x.changed ? { ...c, text: x.text } : c;
        })
      : claims;
    if (phrases) deps.log?.(`[answer] names stripped for verification: ${namesStripped} sentences`);
    const v = verifyClaims(
      scored,
      sources.map((c) => c.passage),
      {
        ...(affinity
          ? {
              meta: sources.map((c) => ({ file: c.file, title: c.title })),
              ...(own.length ? { allowed: new Set(own) } : {}),
            }
          : {}),
        ...(s.params.cjkOverlap ? { cjk: true } : {}),
        ...(crossParts.has('verify') ? { allowedFor: ownFiles(claims, sources, deps) } : {}),
      },
    );
    // The sentences keep their own text; only the scoring read the stripped copy.
    claims = v.claims.map((c, i) => (scored[i] === claims[i] ? c : { ...c, text: claims[i]!.text }));
    verification = v.stats;
    deps.log?.(
      `[answer] verify: ${v.stats.sentences} sentences, ${v.stats.reattributed} re-attributed, ${v.stats.attributed} attributed, ${v.stats.unsupported} unsupported`,
    );
  }
  let hedgesDropped: string[] = [];
  if (s.params.dropUnsupportedHedges && verification) {
    const d = dropHedges(claims);
    claims = d.claims;
    hedgesDropped = d.dropped;
    for (const h of hedgesDropped) deps.log?.(`[answer] hedge dropped: ${h}`);
  }
  const order = verification
    ? citationOrder(
        claims.flatMap((c) => c.citations.map((n): Part => ({ type: 'cite', n }))),
        sources.length,
      )
    : citationOrder(parts, sources.length);
  const result: AnswerResult = {
    // With hedges dropped the text is the kept sentences, so it says what the user sees.
    text: verdict === 'not_found' ? text.trim() : hedgesDropped.length ? claimsText(claims) : answerText.trim(),
    notFound,
    claims,
    cited: order.map((n) => sources[n - 1]!),
    considered: sources.filter((c) => !order.includes(c.n)),
    nearest,
    checked:
      notFound && verdict === null
        ? citationOrder(parseCitations(text), sources.length).map((n) => sources[n - 1]!)
        : [],
    skippedModel: false,
    timings: { firstTokenMs, modelMs },
    stats,
    ...(verification ? { verification } : {}),
    ...(followUp ? { followUp } : {}),
    ...(hedgesDropped.length ? { hedgesDropped } : {}),
    rawText: text,
    questionSent: asked,
    ...(s.params.verifyStripNames ? { namesStripped } : {}),
    ...(s.params.dropAnswerFileNames ? { fileNamesDropped } : {}),
  };
  emit({ type: 'done', result });
  return result;
}

/**
 * crossDocument verify part: for each sentence that names files (namedFileGroups), the sources of
 * those files, so it is attributed only to them; undefined for a sentence that names none, or only
 * files with no selected source.
 */
export function ownFiles(
  claims: Claim[],
  sources: Pick<SourceCard, 'n' | 'documentId'>[],
  deps: Pick<AnswerDeps, 'index' | 'log'>,
): (Set<number> | undefined)[] {
  const identities = deps.index?.identities?.() ?? [];
  const out = claims.map((c) => {
    const docs = new Set(namedFileGroups(c.text, identities).flatMap((g) => g.map((f) => f.documentId)));
    const own = sources.filter((x) => docs.has(x.documentId)).map((x) => x.n);
    return own.length ? new Set(own) : undefined;
  });
  deps.log?.(`[answer] cross-document: ${out.filter(Boolean).length} of ${claims.length} sentences name a file`);
  return out;
}

/** One more call over the same sources for the items the first reply left out; '' when none. */
async function followUpCall(
  messages: ChatMessage[],
  reply: string,
  wanted: number,
  given: number,
  s: Pick<RunSettings, 'chatModel' | 'contextLength' | 'temperature'>,
  deps: AnswerDeps,
  signal?: AbortSignal,
): Promise<string> {
  let more = '';
  await deps.chat(
    {
      model: s.chatModel,
      messages: [
        ...messages,
        { role: 'assistant', content: reply },
        { role: 'user', content: followUpMessage(wanted, given) },
      ],
      temperature: s.temperature,
      contextLength: s.contextLength,
      signal,
    },
    (piece) => (more += piece),
  );
  more = more.trim();
  return !more || isNotFound(more) ? '' : more;
}
