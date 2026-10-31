/**
 * The model call's messages. The sources carry a number, the section path and the text, never a
 * file name or a page: the source cards add those from the section records, so the model has no
 * way to attribute one file's text to another.
 */
import type { PromptVariant } from './params.js';

/** The whole reply when the sources do not answer the question. */
export const NOT_FOUND_MARKER = 'NOT_IN_SOURCES';

const RULES = [
  'Answer the question using only the numbered sources below.',
  'After each sentence that uses a source, cite it as [n], for example [1] or [2][3].',
  'Never write page numbers, file names or section names in your answer; the citations are enough.',
  // A firmer wording (must start with the marker, never explain in own words, with an example) was
  // tried on 2026-10-31: qwen3:14b then refused three answerable multi-part questions whose one
  // part (a page number) was missing; target hit fell from 67 to 44 percent (docs/plan.md).
  `If the sources do not state the specific fact the question asks for, reply with ${NOT_FOUND_MARKER}, even when they discuss related material: do not answer from related material or from placeholders.`,
  `After ${NOT_FOUND_MARKER} you may add one short sentence saying which sources you checked, cited as [n]; nothing else.`,
  'Answer in the language of the question.',
];

const STRICT_RULES = [
  'Every sentence of your answer must end with at least one citation.',
  'Do not add background knowledge, advice or guesses that the sources do not state.',
  'Keep the answer short: the fewest sentences that answer the question.',
];

/** verdictLine: the first line of the reply, which code reads instead of looking for the marker. */
export const VERDICT_FOUND = 'FOUND';
export const VERDICT_NOT_FOUND = 'NOT_FOUND';

const VERDICT_RULES = [
  `Begin your reply with one line containing only ${VERDICT_FOUND} or ${VERDICT_NOT_FOUND}.`,
  `Write ${VERDICT_NOT_FOUND} when the sources do not state the specific fact the question asks for, even when they discuss related material or hold placeholders; write nothing after it.`,
  `Write ${VERDICT_FOUND} when they do, then the answer from the next line on.`,
];

export function systemPrompt(variant: PromptVariant, o: { verdictLine?: boolean } = {}): string {
  // The verdict rules take the place of the two not-found marker rules.
  const base = o.verdictLine ? [...RULES.slice(0, 3), ...VERDICT_RULES, ...RULES.slice(5)] : RULES;
  const rules = variant === 'strict' ? [...base.slice(0, 3), ...STRICT_RULES, ...base.slice(3)] : base;
  return rules.join('\n');
}

export type Verdict = 'found' | 'not_found';

/**
 * Reads the verdict line at the start of a reply. complete is false while the first line may still
 * grow into a verdict; verdict is null when the reply does not start with one, and rest is then
 * the whole reply. Formatting around the word (**FOUND**, # FOUND, a colon) is ignored.
 */
export function readVerdict(text: string): { complete: boolean; verdict: Verdict | null; rest: string } {
  const t = text.replace(/^\s+/, '');
  const nl = t.indexOf('\n');
  const line = (nl < 0 ? t : t.slice(0, nl)).replace(/[\s`*"'>#:.-]+/g, '').toUpperCase();
  const words = [VERDICT_FOUND, VERDICT_NOT_FOUND, 'NOTFOUND'];
  if (nl < 0 && words.some((w) => w.startsWith(line))) return { complete: false, verdict: null, rest: '' };
  const rest = nl < 0 ? '' : t.slice(nl + 1);
  if (line === VERDICT_NOT_FOUND || line === 'NOTFOUND') return { complete: true, verdict: 'not_found', rest };
  if (line === VERDICT_FOUND) return { complete: true, verdict: 'found', rest };
  return { complete: true, verdict: null, rest: text };
}

export interface PromptSource {
  path: string[];
  text: string;
}

export function userMessage(question: string, sources: PromptSource[]): string {
  const blocks = sources.map((s, i) => `[${i + 1}] ${s.path.join(' > ')}\n${s.text.trim()}`);
  return `Sources:\n\n${blocks.join('\n\n')}\n\nQuestion: ${question.trim()}`;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildMessages(
  question: string,
  sources: PromptSource[],
  variant: PromptVariant,
  o: { verdictLine?: boolean } = {},
): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(variant, o) },
    { role: 'user', content: userMessage(question, sources) },
  ];
}

/**
 * True when the reply means the sources do not answer: it starts with the marker (formatting
 * around it ignored), or it holds the marker and cites nothing.
 */
export function isNotFound(answer: string): boolean {
  const t = answer.replace(/^[\s`*"'>#-]+/, '');
  if (t.startsWith(NOT_FOUND_MARKER)) return true;
  return t.includes(NOT_FOUND_MARKER) && !/[[【]\s*\d+\s*[\]】]/.test(t);
}
