/**
 * ruleEchoRefusal (docs/plan.md, round V1). qwen3:14b sometimes copies the not-found instruction
 * of the system prompt as its reply instead of writing the marker (for example: The sources do not
 * state the specific fact the question asks for, even though they discuss related material: do
 * not answer from related material or from placeholders [1]...[5]). isNotFound does not see a
 * refusal in that, so it was scored and shown as an answer citing nothing. Detection is per
 * sentence: a sentence is an echo when at least RULE_ECHO_SHARE of its distinct content words
 * occur in the rule's own text, the marker counting as one of the rule's words, so a bare
 * NOT_IN_SOURCES written after a partial answer is an echo too.
 */
import type { Claim } from './citations.js';
import { NOT_FOUND_MARKER, NOT_FOUND_RULE } from './prompt.js';
import { contentTokens, overlap } from './verify.js';

export const RULE_ECHO_SHARE = 0.8;

// The marker as one token: contentTokens would cut NOT_IN_SOURCES into stopwords and drop it.
const MARKER_TOKEN = '\u0000marker';

function tokensOf(text: string): string[] {
  const t = contentTokens(text.split(NOT_FOUND_MARKER).join(' '));
  return text.includes(NOT_FOUND_MARKER) ? [...t, MARKER_TOKEN] : t;
}

const RULE_TOKENS = new Set(tokensOf(NOT_FOUND_RULE));

/** True when the sentence is a copy of the not-found rule (or the marker alone). */
export function isRuleEcho(text: string): boolean {
  const tokens = tokensOf(text);
  return tokens.length > 0 && overlap(tokens, RULE_TOKENS) >= RULE_ECHO_SHARE;
}

/**
 * Splits the reply's sentences into echoes and the rest. refusal is true when echoes were found
 * and no sentence with words in it is left: the reply then takes the not-found path.
 */
export function splitRuleEchoes(claims: Claim[]): { echoes: Claim[]; rest: Claim[]; refusal: boolean } {
  const echoes = claims.filter((c) => isRuleEcho(c.text));
  if (!echoes.length) return { echoes, rest: claims, refusal: false };
  const rest = claims.filter((c) => !echoes.includes(c));
  return { echoes, rest, refusal: !rest.some((c) => /[\p{L}\p{N}]{2}/u.test(c.text)) };
}
