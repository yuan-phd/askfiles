/**
 * Quote-grounded answering (answerMode quoted). Two model calls instead of one:
 * 1. extraction: the top extractSections sections go to the model, which returns for each the
 *    verbatim excerpts relevant to the question (Ollama structured output, thinking off);
 * 2. verification in code: an excerpt counts only when it is found in that section's text after
 *    normalization (normalizeForMatch); the rest are dropped and counted;
 * 3. abstention in code: with no verified excerpt the not-found state shows the nearest sections
 *    and the model is not called again;
 * 4. composition: the model answers from the verified excerpts alone, numbered 1 to k by section,
 *    citing [n] per sentence; a sentence whose citation has no verified excerpt is unsupported.
 * The source cards show the verified excerpts as their passages.
 */
import { citationOrder, claimsOf, CitationStream, parseCitations, type Part } from './citations.js';
import type { ChatFn } from './ollama-chat.js';
import type { RunSettings } from './params.js';
import { buildMessages, isNotFound, NOT_FOUND_MARKER, type ChatMessage } from './prompt.js';
import type { AnswerSection } from './sections.js';
import type { Selection } from './select.js';
// Types only, so the import cycle with pipeline.ts stays out of the compiled code.
import type { AnswerEvent, AnswerResult, Retrieval, SourceCard } from './pipeline.js';

/** Shortest excerpt, in characters without spaces, worth verifying: shorter ones match anywhere. */
export const MIN_EXCERPT_CHARS = 12;

/**
 * Folds text for the excerpt check: NFKC, lower case, every dash and minus to -, curly quotes to
 * straight ones, a word broken across a line (con- flicts) joined again, and all whitespace removed,
 * since PDF text sometimes runs words together where the model writes a space.
 */
export function normalizeForMatch(t: string): string {
  return t
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
    .replace(/\s+/g, '');
}

const CONTENTS_TITLE = /^(table of )?contents\b|^目录|^目錄/i;
// A contents line: text, a dot leader, then a page number.
const LEADER_LINE = /(?:\.\s*){3,}\s*[\divxlc]+\s*$/i;

/**
 * A table of contents: titled so somewhere on its path, or with dot leaders before page numbers.
 * Lines merely ending in a number are not enough: score sheets and currency tables end that way
 * too, and round 1 dropped three such sections that held the answer (docs/plan.md).
 */
export function isContentsSection(s: Pick<AnswerSection, 'path' | 'title' | 'text'>): boolean {
  if ([...s.path, s.title].some((t) => CONTENTS_TITLE.test(t.trim()))) return true;
  const lines = s.text.split('\n').filter((l) => l.trim().length > 3);
  const leaders = (s.text.match(/(?:\.\s*){5,}/g) ?? []).length;
  return lines.length >= 4 && (lines.filter((l) => LEADER_LINE.test(l)).length / lines.length >= 0.5 || leaders >= 5);
}

export interface Excerpt {
  /** 1-based number of the section in the extraction call. */
  source: number;
  text: string;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    excerpts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { source: { type: 'integer' }, text: { type: 'string' } },
        required: ['source', 'text'],
      },
    },
  },
  required: ['excerpts'],
};

export function extractionMessages(question: string, sections: Pick<AnswerSection, 'path' | 'text'>[]): ChatMessage[] {
  const system = [
    'You find evidence. Below are numbered sources and a question.',
    'For each source, copy word for word the sentences, list items or table rows that help answer the question.',
    'Copy exactly as written in the source: do not paraphrase, shorten, translate, combine or add words. One excerpt per item.',
    'Give no excerpt for a source that has nothing relevant. When no source is relevant, return an empty list.',
    'Reply with JSON: {"excerpts": [{"source": n, "text": "..."}]}.',
  ].join('\n');
  const blocks = sections.map((s, i) => `[${i + 1}] ${s.path.join(' > ')}\n${s.text.trim()}`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Sources:\n\n${blocks.join('\n\n')}\n\nQuestion: ${question.trim()}` },
  ];
}

/** Excerpts from the extraction reply; a reply that is not the expected JSON gives none. */
export function parseExcerpts(raw: string, max: number): Excerpt[] {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return [];
  }
  const list = (data as { excerpts?: unknown })?.excerpts;
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => {
    const source = Number((e as { source?: unknown })?.source);
    const text = (e as { text?: unknown })?.text;
    return Number.isInteger(source) && source >= 1 && source <= max && typeof text === 'string' && text.trim()
      ? [{ source, text: text.trim() }]
      : [];
  });
}

/**
 * Keeps the excerpts found in their own section's text. An excerpt with ... in it is checked piece
 * by piece, so a model that skips words between two quoted runs keeps the runs; pieces shorter
 * than MIN_EXCERPT_CHARS are dropped. Duplicates are dropped too, and not counted.
 */
export function verifyExcerpts(
  excerpts: Excerpt[],
  sections: Pick<AnswerSection, 'text'>[],
): { verified: Map<number, string[]>; kept: number; dropped: number } {
  const verified = new Map<number, string[]>();
  const hay = sections.map((s) => normalizeForMatch(s.text));
  let kept = 0;
  let dropped = 0;
  for (const e of excerpts) {
    for (const piece of e.text.split(/\s*(?:\.\.\.|…)\s*/)) {
      const t = piece
        .trim()
        .replace(/^["'“‘]+|["'”’]+$/g, '')
        .trim();
      const n = normalizeForMatch(t);
      if (n.length < MIN_EXCERPT_CHARS) {
        if (n.length) dropped++;
        continue;
      }
      if (!hay[e.source - 1]!.includes(n)) {
        dropped++;
        continue;
      }
      const list = verified.get(e.source) ?? [];
      if (list.some((x) => normalizeForMatch(x) === n)) continue;
      list.push(t);
      verified.set(e.source, list);
      kept++;
    }
  }
  return { verified, kept, dropped };
}

/** The extra rule of the composition call: the sources are excerpts, nothing else may be used. */
const COMPOSITION_RULE =
  'The sources are verbatim excerpts from the documents. Answer from these excerpts only; do not add anything they do not say.';

export interface QuotedStats {
  /** Sections sent to the extraction call. */
  sections: number;
  excerpts: number;
  verified: number;
  dropped: number;
  /** Sections with at least one verified excerpt: the composition call's sources. */
  supported: number;
  extractMs: number;
}

type CardOf = (n: number, section: AnswerSection, rerank: number | null, trimmed?: boolean) => SourceCard;

export async function answerQuoted(
  question: string,
  r: Retrieval,
  sel: Selection,
  s: Pick<RunSettings, 'params' | 'chatModel' | 'contextLength' | 'temperature'>,
  deps: { chat: ChatFn; log?: (msg: string) => void },
  helpers: { cardOf: CardOf; nearest: SourceCard[] },
  emit: (e: AnswerEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<AnswerResult> {
  const t0 = performance.now();
  const sections = sel.selected.map((x) => x.section);
  const base = { claims: [], cited: [], considered: [], checked: [], nearest: helpers.nearest };
  const notFound = (stats: AnswerResult['stats'], quoted: QuotedStats, skipped: boolean): AnswerResult => {
    const result: AnswerResult = {
      ...base,
      text: '',
      notFound: true,
      skippedModel: skipped,
      timings: { firstTokenMs: null, modelMs: Math.round(performance.now() - t0) },
      stats,
      quoted,
    };
    emit({ type: 'sources', sources: [] });
    emit({ type: 'done', result });
    return result;
  };
  const empty: QuotedStats = { sections: 0, excerpts: 0, verified: 0, dropped: 0, supported: 0, extractMs: 0 };
  if (!sections.length) return notFound({ promptTokens: null, completionTokens: null }, empty, true);

  emit({ type: 'stage', stage: 'answering' });
  let raw = '';
  const extractStats = await deps.chat(
    {
      model: s.chatModel,
      messages: extractionMessages(question, sections),
      temperature: 0,
      contextLength: s.contextLength,
      format: EXTRACTION_SCHEMA,
      signal,
    },
    (piece) => {
      raw += piece;
    },
  );
  const extractMs = Math.round(performance.now() - t0);
  const excerpts = parseExcerpts(raw, sections.length);
  const { verified, kept, dropped } = verifyExcerpts(excerpts, sections);
  const order = [...verified.keys()].sort((a, b) => a - b);
  const quoted: QuotedStats = {
    sections: sections.length,
    excerpts: excerpts.length,
    verified: kept,
    dropped,
    supported: order.length,
    extractMs,
  };
  deps.log?.(
    `[answer] quoted: ${sections.length} sections, ${excerpts.length} excerpts, ${kept} verified, ${dropped} dropped, extraction ${extractMs} ms`,
  );
  if (!order.length) return notFound(extractStats, quoted, false);

  // Composition sources: the sections with verified excerpts, renumbered 1 to k, their passage the excerpts.
  const supported = order.map((n) => ({
    ...sections[n - 1]!,
    text: verified.get(n)!.join('\n'),
  }));
  const ranks = order.map((n) => sel.selected[n - 1]!.rerank);
  const sources = supported.map((sec, i) => helpers.cardOf(i + 1, sec, ranks[i] ?? null));
  emit({ type: 'sources', sources });
  let firstTokenMs: number | null = null;
  let text = '';
  let decided = false;
  const stream = new CitationStream();
  const all: Part[] = [];
  const push = (chunk: string) => {
    const parts = stream.push(chunk);
    all.push(...parts);
    if (parts.length) emit({ type: 'delta', parts });
  };
  const messages = buildMessages(question, supported, s.params.promptVariant);
  messages[0] = { ...messages[0]!, content: `${messages[0]!.content}\n${COMPOSITION_RULE}` };
  const stats = await deps.chat(
    { model: s.chatModel, messages, temperature: s.temperature, contextLength: s.contextLength, signal },
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
  const nf = isNotFound(text);
  if (!nf) {
    if (!decided) push(text);
    const rest = stream.end();
    all.push(...rest);
    if (rest.length) emit({ type: 'delta', parts: rest });
  }
  const parts = nf ? [] : all;
  const cites = citationOrder(parts, sources.length);
  const result: AnswerResult = {
    text: text.trim(),
    notFound: nf,
    claims: nf ? [] : claimsOf(parts, sources.length),
    cited: cites.map((n) => sources[n - 1]!),
    considered: sources.filter((c) => !cites.includes(c.n)),
    nearest: helpers.nearest,
    checked: nf ? citationOrder(parseCitations(text), sources.length).map((n) => sources[n - 1]!) : [],
    skippedModel: false,
    timings: { firstTokenMs, modelMs: Math.round(performance.now() - t0) },
    stats: {
      promptTokens: (extractStats.promptTokens ?? 0) + (stats.promptTokens ?? 0) || null,
      completionTokens: (extractStats.completionTokens ?? 0) + (stats.completionTokens ?? 0) || null,
    },
    quoted,
  };
  emit({ type: 'done', result });
  return result;
}
