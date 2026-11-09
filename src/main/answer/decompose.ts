/**
 * Question decomposition (decomposeQuestions; docs/plan.md round 9). A question is split only on
 * structure it shows: asks joined by and, as well as or a comma list, each starting with a question
 * word, or Compare A and B: ask. Each part runs the whole pipeline on its own, and the answers are
 * merged under short lead-ins with their citations renumbered against the union of the sources.
 *
 * Never split by guessing: a later ask that points back with a pronoun (it, its, that, there) or
 * the former / the latter without a two-member list to resolve them leaves the question whole,
 * since the part alone would not say what it asks about; so does a question whose asks have no
 * lead-in (Under paragraph 4.7, ...) or sentence before them, whose subject sits in the first ask. So does a question with two question
 * sentences, or an ask of one or two words (why), which joins the ask before it.
 */
import { parseCitations, type Claim, type Part } from './citations.js';
import { NEAREST_COUNT, type AnswerEvent, type AnswerResult, type SourceCard } from './pipeline.js';

export interface SubQuestion {
  /** The question the pipeline runs: lead-in, the one ask, and the sentences around it. */
  text: string;
  /** The ask alone, shown above its answer. */
  label: string;
}

export interface Split {
  /** asks: coordinated asks; set: the members of Compare A and B. */
  how: 'asks' | 'set';
  parts: SubQuestion[];
}

/** Most parts a question is split into; more stays whole. */
export const MAX_PARTS = 4;

const QW = String.raw`(?:what|which|who|whom|whose|when|where|why|how|whether)`;
const PREP = String.raw`(?:to|for|in|at|on|under|against|from|by|with|of|into|during|after|before)`;
const AUX = String.raw`(?:can|could|does|do|did|is|are|was|were|must|should|may|might|will|would|has|have)`;
/** Where an ask starts: a question word, after a preposition or not, or an auxiliary (and can the ...). */
const ASK_START = String.raw`(?:(?:${PREP}\s+)?${QW}|${AUX})\b`;
/** A separator before another ask: comma, and, as well as, or a comma with either. */
const SEPARATOR = new RegExp(
  String.raw`(?:,\s+(?:and\s+|as well as\s+)?|\s+(?:and|as well as)\s+)(?=${ASK_START})`,
  'gi',
);
/** The first ask of the sentence, at its start or after a comma or colon. */
const FIRST_ASK = new RegExp(String.raw`(?:^|[,:]\s+)((?:${PREP}\s+)?${QW}\b)`, 'i');
const ANAPHOR = /\b(?:it|its|they|them|their|theirs|there|this|that|these|those|he|she|him|her|such|same)\b/i;
const FORMER_LATTER = /\bthe (former|latter)\b/gi;
/** Two members named in the lead-in: Using A and B, / In A and B: */
const PAIR = /\b(?:using|in|from|between|compare|of)\s+(?:both\s+)?(.+?)\s+and\s+(.+?)\s*(?:[,:]|$)/i;
const COMPARE = /^(?:compare|contrast)\s+(.+?)\s+(?:and|with)\s+(.+?)\s*[:;]\s*(.+)$/i;

function sentences(q: string): string[] {
  return q
    .trim()
    .split(/(?<=[.?!])\s+(?=["'A-Z0-9])/)
    .filter(Boolean);
}

const upperFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** The parts of a question, or null when its structure does not split it. */
export function splitQuestion(question: string): Split | null {
  const all = sentences(question);
  const asks = all.filter((x) => x.trim().endsWith('?'));
  if (asks.length !== 1) return null;
  const at = all.indexOf(asks[0]!);
  const before = all.slice(0, at).join(' ');
  const after = all.slice(at + 1).join(' ');
  const target = asks[0]!.trim().replace(/\?+$/, '');
  const join = (...xs: string[]) => xs.filter(Boolean).join(' ');

  // Compare A and B: ask, one part per member. The sentences after it speak of both, so they go.
  const cmp = COMPARE.exec(target);
  if (cmp) {
    const members = [cmp[1]!, cmp[2]!].map((m) => m.trim());
    if (members.some((m) => m.includes(',') || words(m) > 8)) return null;
    const ask = cmp[3]!.trim();
    return {
      how: 'set',
      parts: members.map((m) => ({ text: join(before, `In ${m}, ${ask}?`), label: upperFirst(m) })),
    };
  }

  const first = FIRST_ASK.exec(target);
  if (!first) return null;
  const askFrom = first.index + first[0].length - first[1]!.length;
  const leadIn = target.slice(0, askFrom);
  // Without a lead-in or a sentence before, what the question is about sits in its first ask.
  if (!leadIn.trim() && !before) return null;
  const body = target.slice(askFrom);
  const cuts = [...body.matchAll(SEPARATOR)];
  if (!cuts.length) return null;
  let pieces: string[] = [];
  let from = 0;
  for (const c of cuts) {
    pieces.push(body.slice(from, c.index));
    from = c.index! + c[0].length;
  }
  pieces.push(body.slice(from));
  // A one- or two-word ask (why) belongs to the ask before it.
  const merged: string[] = [];
  for (const p of pieces) {
    if (merged.length && words(p) <= 2) merged[merged.length - 1] = `${merged[merged.length - 1]}, ${p}`;
    else merged.push(p);
  }
  pieces = merged.map((p) => p.trim()).filter(Boolean);
  if (pieces.length < 2 || pieces.length > MAX_PARTS) return null;

  // the former / the latter resolve only against a two-member list before the asks.
  const pair = PAIR.exec(join(before, leadIn));
  const resolved: string[] = [];
  for (const p of pieces) {
    if (/\bthe (?:former|latter)\b/i.test(p) && !pair) return null;
    resolved.push(p.replace(FORMER_LATTER, (_, w: string) => (w.toLowerCase() === 'former' ? pair![1]! : pair![2]!)));
  }
  if (resolved.slice(1).some((p) => ANAPHOR.test(p))) return null;
  return {
    how: 'asks',
    parts: resolved.map((p) => ({
      text: join(before, leadIn ? `${leadIn}${p}?` : `${upperFirst(p)}?`, after),
      label: `${upperFirst(p)}?`,
    })),
  };
}

export function describeSplit(s: Split): string {
  return `${s.how}, ${s.parts.length} parts: ${s.parts.map((p) => `"${p.label}"`).join(' | ')}`;
}

const keyOf = (c: SourceCard) => `${c.documentId}#${c.sectionIndex}`;

/** Shown under a part's lead-in when its sources do not answer it. */
export const PART_NOT_FOUND = 'The documents do not state this.';

/**
 * Runs each part through run (the whole pipeline for one question) and merges the results. Events
 * stream as they come: the sources list grows by each part's new sections, so numbers already
 * shown never change, and each part's citations are rewritten to the merged numbers.
 */
export async function answerSplit(
  split: Split,
  run: (part: SubQuestion, emit: (e: AnswerEvent) => void) => Promise<AnswerResult>,
  emit: (e: AnswerEvent) => void = () => {},
): Promise<AnswerResult> {
  const union: SourceCard[] = [];
  const results: { result: AnswerResult; map: Map<number, number> }[] = [];
  let staged = false;
  const t0 = performance.now();
  let firstTokenMs: number | null = null;
  const subMs: number[] = [];
  for (const [i, part] of split.parts.entries()) {
    const map = new Map<number, number>();
    let led = false;
    const lead = () => {
      if (led) return;
      led = true;
      emit({ type: 'delta', parts: [{ type: 'text', text: `${i ? '\n\n' : ''}${part.label}\n` }] });
    };
    const t1 = performance.now();
    const result = await run(part, (e) => {
      if (e.type === 'stage') {
        if (e.stage === 'answering' && !staged) emit(e);
        staged ||= e.stage === 'answering';
      } else if (e.type === 'progress') {
        // Each part's progress as it comes; the page shows it only until the first words.
        emit(e);
      } else if (e.type === 'sources') {
        for (const c of e.sources) {
          let n = union.findIndex((u) => keyOf(u) === keyOf(c)) + 1;
          if (!n) n = union.push({ ...c, n: union.length + 1 });
          map.set(c.n, n);
        }
        emit({ type: 'sources', sources: [...union] });
      } else if (e.type === 'delta') {
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - t0);
        lead();
        emit({ type: 'delta', parts: remapParts(e.parts, map) });
      }
    });
    subMs.push(Math.round(performance.now() - t1));
    // A part with no sources still gets its numbers, for its checked and nearest cards.
    for (const c of [...result.cited, ...result.considered])
      if (!map.has(c.n)) {
        let n = union.findIndex((u) => keyOf(u) === keyOf(c)) + 1;
        if (!n) n = union.push({ ...c, n: union.length + 1 });
        map.set(c.n, n);
      }
    if (result.notFound) {
      lead();
      emit({ type: 'delta', parts: [{ type: 'text', text: PART_NOT_FOUND }] });
    }
    results.push({ result, map });
  }
  return mergeResults(split, results, { firstTokenMs, modelMs: Math.round(performance.now() - t0), subMs }, union);
}

function remapParts(parts: Part[], map: Map<number, number>): Part[] {
  return parts.flatMap((p): Part[] => {
    if (p.type !== 'cite') return [p];
    const n = map.get(p.n);
    return n ? [{ type: 'cite', n }] : [];
  });
}

function remapText(text: string, map: Map<number, number>): string {
  return remapParts(parseCitations(text), map)
    .map((p) => (p.type === 'cite' ? `[${p.n}]` : p.text))
    .join('');
}

/** The merged result: lead-in, then each part's answer or PART_NOT_FOUND, in part order. */
export function mergeResults(
  split: Split,
  results: { result: AnswerResult; map: Map<number, number> }[],
  timings: { firstTokenMs: number | null; modelMs: number; subMs: number[] },
  union: SourceCard[],
): AnswerResult {
  const notFound = results.every((x) => x.result.notFound);
  const claims: Claim[] = [];
  const texts: string[] = [];
  for (const [i, { result, map }] of results.entries()) {
    const label = split.parts[i]!.label;
    claims.push({ text: `${i ? '\n\n' : ''}${label}\n`, citations: [], unsupported: false });
    if (result.notFound) {
      claims.push({ text: PART_NOT_FOUND, citations: [], unsupported: false });
      texts.push(`${label}\n${PART_NOT_FOUND}`);
      continue;
    }
    for (const c of result.claims)
      claims.push({ ...c, citations: [...new Set(c.citations.map((n) => map.get(n) ?? 0).filter(Boolean))] });
    texts.push(`${label}\n${remapText(result.text, map)}`);
  }
  const order: number[] = [];
  for (const c of claims) for (const n of c.citations) if (!order.includes(n)) order.push(n);
  const cards = (list: SourceCard[], map: Map<number, number>) =>
    list.map((c) => union[(map.get(c.n) ?? 0) - 1]).filter((c): c is SourceCard => Boolean(c));
  const nearest: SourceCard[] = [];
  for (const { result } of results)
    for (const c of result.nearest)
      if (!nearest.some((x) => keyOf(x) === keyOf(c)) && nearest.length < NEAREST_COUNT)
        nearest.push({ ...c, n: nearest.length + 1 });
  const checked: SourceCard[] = [];
  for (const { result, map } of results)
    for (const c of cards(result.checked, map)) if (!checked.includes(c)) checked.push(c);
  const sum = (f: (r: AnswerResult) => number | null | undefined) => {
    const v = results.map((x) => f(x.result)).filter((x): x is number => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const verified = results.some((x) => x.result.verification);
  return {
    text: notFound ? (results[0]?.result.text ?? '') : texts.join('\n\n'),
    notFound,
    claims: notFound ? [] : claims,
    cited: notFound ? [] : order.map((n) => union[n - 1]!),
    considered: notFound ? [] : union.filter((c) => !order.includes(c.n)),
    nearest,
    checked: notFound ? checked : [],
    skippedModel: results.every((x) => x.result.skippedModel),
    timings: { firstTokenMs: timings.firstTokenMs, modelMs: timings.modelMs },
    stats: { promptTokens: sum((r) => r.stats.promptTokens), completionTokens: sum((r) => r.stats.completionTokens) },
    ...(verified
      ? {
          verification: {
            sentences: sum((r) => r.verification?.sentences) ?? 0,
            reattributed: sum((r) => r.verification?.reattributed) ?? 0,
            attributed: sum((r) => r.verification?.attributed) ?? 0,
            unsupported: sum((r) => r.verification?.unsupported) ?? 0,
          },
        }
      : {}),
    split: {
      how: split.how,
      parts: split.parts.map((p) => p.text),
      notFound: results.map((x) => x.result.notFound),
      ms: timings.subMs,
    },
  };
}
