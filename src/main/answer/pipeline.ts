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
import { citationOrder, claimsOf, CitationStream, type Claim, type Part } from './citations.js';
import { fuse, sectionKey, type FusedSection, type KeywordCandidate, type VectorCandidate } from './fusion.js';
import type { ChatFn } from './ollama-chat.js';
import { contextBudget, sectionCap, type AnswerParams, type AnswerScope, type RunSettings } from './params.js';
import { buildMessages, isNotFound, NOT_FOUND_MARKER } from './prompt.js';
import type { Reranker } from './reranker.js';
import { toAnswerSection, type AnswerSection } from './sections.js';
import { selectSections, type Ranked, type Selection } from './select.js';
import { extractTerms, isMainlyCjk, type Term } from './terms.js';

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

  const fused = fuse(vector, keyword, p.rrfK);
  const cap = sectionCap(p, s.chunkMaxChars);
  const candidates: AnswerSection[] = [];
  for (const f of fused) {
    if (candidates.length >= p.candidateSections) break;
    const [docId, idx] = [f.key.slice(0, f.key.lastIndexOf('#')), Number(f.key.slice(f.key.lastIndexOf('#') + 1))];
    const found = deps.index.section(docId, idx);
    if (found) candidates.push(toAnswerSection(found.document, found.section, cap, f.hitTexts));
  }

  let bypassReason: string | null = null;
  if (!deps.reranker) bypassReason = 'no reranker installed';
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
  };
}

/** Candidates in final rank order: by rerank score, or in fused order when bypassed. */
export function ranked(r: Retrieval): Ranked[] {
  const list = r.candidates.map((section, i) => ({ section, rerank: r.rerank[i] ?? null, order: i }));
  if (!r.bypass) list.sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0) || a.order - b.order);
  return list.map(({ section, rerank }) => ({ section, rerank }));
}

export interface ChoiceSettings {
  params: AnswerParams;
  scope: AnswerScope;
  contextLength: number;
}

export function choose(r: Retrieval, s: ChoiceSettings): Selection {
  return selectSections(ranked(r), {
    count: s.params.sectionCount[s.scope],
    floor: s.params.rerankFloor[s.scope],
    budgetTokens: contextBudget(s.params, s.contextLength),
    bypass: r.bypass,
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
  /** True when no section passed the floor, so the model was not asked. */
  skippedModel: boolean;
  timings: { firstTokenMs: number | null; modelMs: number };
  stats: { promptTokens: number | null; completionTokens: number | null };
}

export type AnswerEvent =
  | { type: 'stage'; stage: 'retrieving' | 'answering' }
  | { type: 'sources'; sources: SourceCard[] }
  | { type: 'delta'; parts: Part[] }
  | { type: 'done'; result: AnswerResult };

/** Sections shown under nothing found. */
export const NEAREST_COUNT = 8;

export async function answer(
  question: string,
  r: Retrieval,
  sel: Selection,
  s: Pick<RunSettings, 'params' | 'chatModel' | 'contextLength' | 'temperature'>,
  deps: Pick<PipelineDeps, 'chat'>,
  emit: (e: AnswerEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<AnswerResult> {
  const sources = sel.selected.map((x, i) => cardOf(i + 1, x.section, x.rerank, x.trimmed));
  const nearest = ranked(r)
    .slice(0, NEAREST_COUNT)
    .map((x, i) => cardOf(i + 1, x.section, x.rerank));
  emit({ type: 'sources', sources });
  const base = { claims: [], cited: [], considered: [], nearest, timings: { firstTokenMs: null, modelMs: 0 } };
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
  const t0 = performance.now();
  let firstTokenMs: number | null = null;
  let text = '';
  // Nothing is shown while the reply may still turn out to be the not-found marker.
  let decided = false;
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
      messages: buildMessages(
        question,
        sel.selected.map((x) => x.section),
        s.params.promptVariant,
      ),
      temperature: s.temperature,
      contextLength: s.contextLength,
      signal,
    },
    (piece) => {
      if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - t0);
      text += piece;
      if (decided) return push(piece);
      const t = text.trimStart();
      if (NOT_FOUND_MARKER.startsWith(t) || t.startsWith(NOT_FOUND_MARKER)) return;
      decided = true;
      push(text);
    },
  );
  const modelMs = Math.round(performance.now() - t0);
  const notFound = isNotFound(text);
  if (!notFound) {
    if (!decided) push(text);
    const rest = stream.end();
    all.push(...rest);
    if (rest.length) emit({ type: 'delta', parts: rest });
  }
  const parts = notFound ? [] : all;
  const order = citationOrder(parts, sources.length);
  const result: AnswerResult = {
    text: text.trim(),
    notFound,
    claims: notFound ? [] : claimsOf(parts, sources.length),
    cited: order.map((n) => sources[n - 1]!),
    considered: sources.filter((c) => !order.includes(c.n)),
    nearest,
    skippedModel: false,
    timings: { firstTokenMs, modelMs },
    stats,
  };
  emit({ type: 'done', result });
  return result;
}
