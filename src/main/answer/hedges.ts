/**
 * Hedge filter (dropUnsupportedHedges; docs/plan.md, after round 9). An answer that has its facts
 * often adds a sentence saying something else is missing (The physical PDF page and printed page
 * are not specified in the sources.), which verifyCitations marks unsupported, so the user sees a
 * muted warning on a remark that is not a claim. Such a sentence is deleted when the answer keeps
 * at least one supported sentence; a supported sentence is never deleted.
 */
import type { Claim } from './citations.js';

/** Phrases that say information is missing, in English and Chinese. */
const HEDGE =
  /\b(?:not (?:specified|stated|explicitly|mentioned|provided|given|included|indicated|detailed|defined|listed|identified|available|found|clear|described|addressed)|no (?:information|mention|details?|indication)|(?:does|do|did) not (?:specify|state|mention|provide|include|indicate|give|say|list|identify|describe)|unspecified|neither (?:specified|stated|mentioned))\b|未(?:说明|提及|提供|明确|指定|列出|注明)|没有(?:提供|提及|说明|明确)|无(?:相关)?信息/i;

export function isHedge(text: string): boolean {
  return HEDGE.test(text);
}

/** True for a sentence that carries a citation, the ones a deletion must leave. */
const supported = (c: Claim) => !c.unsupported && c.citations.length > 0;

/** The claims without unsupported hedges, and the deleted sentences; unchanged when none would remain supported. */
export function dropHedges(claims: Claim[]): { claims: Claim[]; dropped: string[] } {
  if (!claims.some(supported)) return { claims, dropped: [] };
  const dropped: string[] = [];
  const kept = claims.filter((c) => {
    if (!c.unsupported || !isHedge(c.text)) return true;
    dropped.push(c.text.trim());
    return false;
  });
  return { claims: kept, dropped };
}

/** The claims as one text with their citations, as the Ask page renders them. */
export function claimsText(claims: Claim[]): string {
  return claims
    .map(
      (c) => c.text.replace(/\s+$/, '') + c.citations.map((n) => `[${n}]`).join('') + (/\s+$/.exec(c.text)?.[0] ?? ' '),
    )
    .join('')
    .trim();
}
