/**
 * judgeRerank (docs/plan.md, round B): for a question naming two or more files, each named file's
 * first JUDGE_WINDOW sections of its in-file fused list are scored one by one by the chat model,
 * 0 to 3 for how directly the text answers the question, and reordered by that score before the
 * file's quota is taken. The candidates come from the in-file search with the file's own clause
 * (subquery.ts), the list on which the round's pre-check found every expected section within 15.
 * Everything after the quota (selection, prompt, verification) is unchanged.
 */
import type { BrowseSection } from '../browse/index.js';
import type { FusedSection } from './fusion.js';
import type { ChatFn } from './ollama-chat.js';
import type { ChatMessage } from './prompt.js';
import { matchedParts } from './sections.js';

/** Candidates per named file: the pre-check of round B put every expected section within 15. */
export const JUDGE_WINDOW = 15;
/** The judge call's own sampling, whatever the answer call uses: deterministic and seeded. */
export const JUDGE_TEMPERATURE = 0;
export const JUDGE_SEED = 42;
/** Room for a digit and a stray token, so a reply that is more than a digit shows as such. */
export const JUDGE_MAX_TOKENS = 8;

/** Fixed in code, not in the presets: the scale is part of the method being measured. */
export const JUDGE_SYSTEM = [
  'You grade how directly a passage from a document answers a question.',
  'Reply with one digit and nothing else:',
  '3 = the passage states the answer to the question, or to a part of it, directly;',
  '2 = the passage holds information that partly answers the question;',
  '1 = the passage is on the topic of the question but does not answer it;',
  '0 = the passage does not help answer the question.',
].join('\n');

/** Question first, so the system prompt and the question are a prefix Ollama can reuse across candidates. */
export function judgeMessages(question: string, path: string[], text: string): ChatMessage[] {
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content: `Question: ${question}\n\nSection: ${path.join(' > ')}\n\nPassage:\n${text}\n\nGrade (one digit, 0 to 3):`,
    },
  ];
}

/** The score when the reply is a single digit 0 to 3, else null (missing, never 0). */
export function parseJudgeScore(reply: string): number | null {
  const t = reply.trim();
  return /^[0-3]$/.test(t) ? Number(t) : null;
}

/**
 * Candidates in judged order. Scored ones are sorted by score descending, fused rank breaking ties,
 * and fill the positions of the scored ones; a candidate with a missing score keeps its own fused
 * position. Items are given in fused order.
 */
export function judgeOrder<T>(items: T[], scores: (number | null)[]): T[] {
  const scored = items
    .map((x, i) => ({ x, i, s: scores[i] ?? null }))
    .filter((y): y is { x: T; i: number; s: number } => y.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  let k = 0;
  return items.map((x, i) => ((scores[i] ?? null) === null ? x : scored[k++]!.x));
}

/**
 * The text the judge reads: the section's matched sub-chunks only (vector hits, then parts with a
 * keyword term; matchedParts), in document order, joined by blank lines. A section without parts
 * gives its text; one with no matched part gives its first part.
 */
export function judgeText(
  section: Pick<BrowseSection, 'parts' | 'text'>,
  f: Pick<FusedSection, 'hitTexts' | 'terms'>,
): string {
  const parts = section.parts?.length ? section.parts : [section.text];
  const matched = matchedParts(parts, f.hitTexts, f.terms).sort((a, b) => a - b);
  return (matched.length ? matched : [0]).map((i) => parts[i]!).join('\n\n');
}

export interface JudgedCandidate {
  key: string;
  path: string[];
  /** 1-based rank in the file's fused list, and after the judge. */
  fusedRank: number;
  judgedRank: number;
  score: number | null;
  /** The reply as written when it was not a single digit, or the error of a failed call. */
  failure?: string;
  ms: number;
  chars: number;
}

export interface JudgedFile {
  documentId: string;
  /** The in-file search's query: the file's clause, or the whole question. */
  query: string;
  candidates: JudgedCandidate[];
  ms: number;
}

export interface JudgeDeps {
  chat: ChatFn;
  model: string;
  /** The answer call's num_ctx, so the judge does not make Ollama reload the model. */
  contextLength: number;
  section(key: string): { section: BrowseSection } | null;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  /** Called before each candidate's call: n of total (display only). */
  onCandidate?: (n: number, total: number) => void;
}

/** Scores the first JUDGE_WINDOW sections of one file's fused list, sequentially, and reorders them. */
export async function judgeFile(
  question: string,
  documentId: string,
  query: string,
  fused: FusedSection[],
  d: JudgeDeps,
): Promise<{ ordered: FusedSection[]; record: JudgedFile }> {
  const t0 = performance.now();
  const window = fused.slice(0, JUDGE_WINDOW);
  const candidates: JudgedCandidate[] = [];
  for (const [i, f] of window.entries()) {
    d.onCandidate?.(i + 1, window.length);
    const found = d.section(f.key);
    const path = found ? (found.section.path.length ? found.section.path : [found.section.title]) : [];
    const text = found ? judgeText(found.section, f) : '';
    const t1 = performance.now();
    let reply = '';
    let failure: string | undefined;
    try {
      await d.chat(
        {
          model: d.model,
          messages: judgeMessages(question, path, text),
          temperature: JUDGE_TEMPERATURE,
          seed: JUDGE_SEED,
          maxTokens: JUDGE_MAX_TOKENS,
          contextLength: d.contextLength,
          signal: d.signal,
        },
        (piece) => (reply += piece),
      );
    } catch (e) {
      if (d.signal?.aborted) throw e;
      failure = `error: ${(e as Error).message}`;
    }
    const score = failure ? null : parseJudgeScore(reply);
    if (score === null && !failure) failure = reply;
    if (failure !== undefined)
      d.log?.(`[answer] judge: no score for ${f.key} (${JSON.stringify(failure.slice(0, 80))})`);
    candidates.push({
      key: f.key,
      path,
      fusedRank: i + 1,
      judgedRank: 0,
      score,
      ...(failure !== undefined ? { failure } : {}),
      ms: Math.round(performance.now() - t1),
      chars: text.length,
    });
  }
  const order = judgeOrder(
    candidates,
    candidates.map((c) => c.score),
  );
  order.forEach((c, i) => (c.judgedRank = i + 1));
  const byKey = new Map(window.map((f) => [f.key, f]));
  const ordered = [...order.map((c) => byKey.get(c.key)!), ...fused.slice(JUDGE_WINDOW)];
  const ms = Math.round(performance.now() - t0);
  const n = (s: number | null) => candidates.filter((c) => c.score === s).length;
  d.log?.(
    `[answer] judge: ${documentId}: ${candidates.length} candidates in ${ms} ms, scores 3:${n(3)} 2:${n(2)} 1:${n(1)} 0:${n(0)} missing:${n(null)}`,
  );
  return { ordered, record: { documentId, query, candidates, ms } };
}
