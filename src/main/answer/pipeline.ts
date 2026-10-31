/**
 * The answer pipeline (docs/plan.md, Answer pipeline): candidates from vector search and the
 * keyword index, fused by reciprocal rank, grouped into sections, reranked with a cross-encoder,
 * selected by the answer scope, then one streamed model call over numbered sources. Upstream
 * stays the document store and vector database; its chat route is not used.
 *
 * Three stages, so the eval can cache the first and sweep the second without the model:
 * retrieve (candidates, fusion, sections, rerank), choose (floor, count, budget), answer.
 */
import type { BrowseDocument, BrowseSection, DocumentRef, RankedSection } from '../browse/index.js';
import { mentionedDocuments, type FileIdentity } from '../browse/identifiers.js';
import { citationOrder, claimsOf, CitationStream, parseCitations, type Claim, type Part } from './citations.js';
import { fuse, sectionKey, type FusedSection, type KeywordCandidate, type VectorCandidate } from './fusion.js';
import type { ChatFn } from './ollama-chat.js';
import {
  contextBudget,
  floorOf,
  rerankerOff,
  sectionCap,
  type AnswerParams,
  type AnswerScope,
  type RunSettings,
} from './params.js';
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
  sectionFrequency(term: string): number;
  rankSections(terms: string[], limit: number): RankedSection[];
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
  const raw = await deps.vectorSearch(question, p.vectorTopK, signal);
  const chunks = raw.map((r, i) => ({
    id: r.id ?? `chunk-${i}`,
    url: r.metadata?.url ?? null,
    title: r.metadata?.title ?? null,
    text: chunkBody(r.text ?? ''),
    score: typeof r.score === 'number' ? r.score : null,
  }));
  const located = await deps.resolveSources(chunks);
  const vector = located.map((c) => {
    const doc = deps.index.getDocument({ url: c.url, title: c.title });
    const section = doc && typeof c.sectionIndex === 'number' ? sectionKey(doc.id, c.sectionIndex) : null;
    return { id: c.id, text: c.text, score: c.score, section, file: doc?.title ?? c.title };
  });
  const t1 = performance.now();

  const terms = extractTerms(question, {
    total: deps.index.sectionTotal(),
    frequency: (t) => deps.index.sectionFrequency(t),
  });
  const keyword: KeywordCandidate[] = terms.length
    ? deps.index
        .rankSections(
          terms.map((t) => t.text),
          p.keywordTopK,
        )
        .map((r) => ({
          section: sectionKey(r.documentId, r.sectionIndex),
          score: r.score,
          terms: r.terms,
        }))
    : [];
  const t2 = performance.now();

  let fused = fuse(vector, keyword, p.rrfK);
  let affinity: Retrieval['affinity'];
  if (p.documentAffinity) {
    const named = mentionedDocuments(question, deps.index.identities?.() ?? []);
    affinity = { documentIds: named.map((f) => f.documentId), files: named.map((f) => f.file) };
    fused = boostDocuments(fused, new Set(affinity.documentIds));
    if (named.length) deps.log?.(`[answer] affinity: ${affinity.files.join(', ')}`);
  }
  const cap = sectionCap(p, s.chunkMaxChars);
  const candidates: AnswerSection[] = [];
  for (const f of fused) {
    if (candidates.length >= p.candidateSections) break;
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

export function choose(r: Retrieval, s: ChoiceSettings): Selection {
  // A per-question bypass (CJK, model files missing) keeps its old meaning: no floor at all.
  const floorOn = rerankerOff(s.params) ? 'vector' : r.bypass ? 'none' : 'rerank';
  // quoted mode sends extractSections sections to its extraction call, never a table of contents.
  const quoted = s.params.answerMode === 'quoted';
  const list = quoted ? ranked(r).filter((x) => !isContentsSection(x.section)) : ranked(r);
  return selectSections(list, {
    count: quoted ? s.params.extractSections : s.params.sectionCount[s.scope],
    floor: floorOf(s.params, s.scope),
    budgetTokens: contextBudget(s.params, s.contextLength),
    floorOn,
  });
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
  const sources = sel.selected.map((x, i) => cardOf(i + 1, sections[i]!, x.rerank, x.trimmed));
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
  const promptSources: PromptSource[] = sections.map((x) => ({
    path: x.path,
    text: x.text,
    file: x.file,
    title: x.title,
    type: typeOf.get(x.documentId) ?? '',
  }));
  const enumerate = s.params.enumerateWhenAsked && isSetQuestion(question);
  const messages = buildMessages(question, promptSources, s.params.promptVariant, {
    verdictLine,
    fileHeaders: affinity,
    enumerate,
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
  const parts = notFound ? [] : all;
  let claims = notFound ? [] : claimsOf(parts, sources.length);
  let verification: VerifyStats | undefined;
  if (s.params.verifyCitations && claims.length) {
    // A question naming exactly one file may be attributed only to its sources, when any is selected.
    const named = affinity && r.affinity?.documentIds.length === 1 ? r.affinity.documentIds[0] : null;
    const own = named ? sources.filter((c) => c.documentId === named).map((c) => c.n) : [];
    const v = verifyClaims(
      claims,
      sources.map((c) => c.passage),
      affinity
        ? {
            meta: sources.map((c) => ({ file: c.file, title: c.title })),
            ...(own.length ? { allowed: new Set(own) } : {}),
          }
        : {},
    );
    claims = v.claims;
    verification = v.stats;
    deps.log?.(
      `[answer] verify: ${v.stats.sentences} sentences, ${v.stats.reattributed} re-attributed, ${v.stats.attributed} attributed, ${v.stats.unsupported} unsupported`,
    );
  }
  const order = verification
    ? citationOrder(
        claims.flatMap((c) => c.citations.map((n): Part => ({ type: 'cite', n }))),
        sources.length,
      )
    : citationOrder(parts, sources.length);
  const result: AnswerResult = {
    text: verdict === 'not_found' ? text.trim() : answerText.trim(),
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
  };
  emit({ type: 'done', result });
  return result;
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
