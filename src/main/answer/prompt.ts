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
  `If the sources do not contain the answer, reply with exactly ${NOT_FOUND_MARKER} and nothing else.`,
  'Answer in the language of the question.',
];

const STRICT_RULES = [
  'Every sentence of your answer must end with at least one citation.',
  'Do not add background knowledge, advice or guesses that the sources do not state.',
  'Keep the answer short: the fewest sentences that answer the question.',
];

export function systemPrompt(variant: PromptVariant): string {
  const rules = variant === 'strict' ? [...RULES.slice(0, 3), ...STRICT_RULES, ...RULES.slice(3)] : RULES;
  return rules.join('\n');
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

export function buildMessages(question: string, sources: PromptSource[], variant: PromptVariant): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(variant) },
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
