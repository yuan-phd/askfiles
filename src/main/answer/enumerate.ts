/**
 * Conditional completeness (enumerateWhenAsked, enumerateFollowUp; docs/plan.md round 8). A
 * question that asks for a set of things gets one more rule in the system prompt; when it also
 * states how many and the answer lists fewer, one follow-up call asks for the rest. Questions
 * that ask for one fact are left alone, since the round 5 rule applied to every question made
 * the model answer an absent question from related material.
 */

const NUMBER_WORDS = 'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty';
const NUMBER_VALUES: Record<string, number> = Object.fromEntries(
  NUMBER_WORDS.split('|').map((w, i) => [w, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20][i]!]),
);

/** A plural noun, roughly: a word of three or more letters ending in s but not ss, us or is. */
const PLURAL = String.raw`[a-z][a-z-]*[a-hj-rt-z]s`;

/**
 * A count before a plural noun, with at most one word between (three main groups, 3 weighted
 * scores). Four-digit years are not counts (the 2025 Procurement Regulations), nor decimals.
 */
const COUNT = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])(${NUMBER_WORDS}|\d{1,3})(?![\p{N}.,]\d)\s+(?:[a-z-]+\s+)?(?:${PLURAL})\b`,
  'iu',
);

const SET_WORDS =
  /\b(?:what are the|list|each|all|components|steps|conditions|requirements|activities|elements|factors)\b/i;

/** Chinese: which (plural), list, each, all, components, steps, conditions, requirements, activities, elements, factors, or a count with a classifier. */
const SET_WORDS_ZH =
  /哪些|列出|列举|每个|每一|所有|全部|组成部分|步骤|条件|要求|活动|要素|因素|[两二三四五六七八九十几\d]+(?:个|项|种|条|类|步)/;

/** True when the question asks for a set of items rather than one fact. */
export function isSetQuestion(question: string): boolean {
  return COUNT.test(question) || SET_WORDS.test(question) || SET_WORDS_ZH.test(question);
}

/** The count the question states (three activities: 3), or null. */
export function statedCount(question: string): number | null {
  const m = COUNT.exec(question);
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  const n = /^\d+$/.test(w) ? Number(w) : (NUMBER_VALUES[w] ?? null);
  return n !== null && n >= 2 ? n : null;
}

/**
 * Items the answer enumerates: its list lines (-, *, bullets, 1. or 1)) when it has any, else
 * inline markers such as (1) (2) or (a) (b), else its cited sentences, since a prose answer
 * usually gives one item per sentence. Citations alone on a line are not items.
 */
export function enumeratedItems(answer: string, citedSentences: number): number {
  const lines = answer.split('\n').filter((l) => /^\s*(?:[-*•●]|\d{1,2}[.)]|[a-z][.)])\s+\S/i.test(l));
  if (lines.length) return lines.length;
  const inline = answer.match(/(?:^|\s)\((?:\d{1,2}|[a-z]|[ivx]{1,4})\)\s/gi);
  if (inline && inline.length >= 2) return inline.length;
  return citedSentences;
}

export const ENUMERATE_RULE =
  'The question asks for a set of items: first count the items in the cited sources that answer the question, then give every one of them, each with its citation; do not summarize them into fewer items.';

/**
 * noSummarizing: the rule for every question. Round 8a's causes were omissions in answers that
 * grouped several listed items under one sentence (docs/plan.md round 9).
 */
export const NO_SUMMARIZING_RULE =
  'Do not summarize, merge or group what the sources say; when the sources list several items, state each item separately as the source states it, with its citation; when the question asks for a set, give every member.';

export function followUpMessage(wanted: number, given: number): string {
  return `The question asks for ${wanted} items and your answer gives ${given}. From the same numbered sources, give only the missing items, each in its own sentence with its citation [n]. Do not repeat the items already given and add nothing the sources do not state. If the sources hold no more items, reply with nothing.`;
}
