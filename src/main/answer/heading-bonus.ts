/**
 * headingPathBonus (docs/plan.md, round X2): a fused section whose heading path holds one of the
 * question's keyword terms gets a fixed bonus on its fused score. English terms match by their
 * Porter stems as whole words (planning meets Leave Plan); a CJK n-gram matches anywhere in
 * the path, spaces ignored. Only sections already in the fused list get it: a title alone does
 * not make a candidate.
 *
 * Size and cap. The bonus is HEADING_BONUS_SHARE of the RRF of rank 1, 0.5/(k+1), given once
 * however many terms match. A section in one list only, even at rank 1, then scores at most
 * 1.6/(k+1) with the multi-hit tie-breaker (MULTI_HIT_SHARE, 10 percent of the score before the bonus); a section both lists rank r or
 * better scores at least 2/(k+r), more than that for r up to 16 at k 60 (21 without further
 * sub-chunks). So a heading match lifts a section over single-list neighbours and weak two-list
 * matches, but never over a section both lists put in their top 16.
 */
import { fold } from '../browse/index.js';
import { stemFolded } from '../browse/stem.js';
import { isMainlyCjk, type Term } from './terms.js';

export const HEADING_BONUS_SHARE = 0.5;

/** The bonus for RRF constant k. */
export function headingBonus(k: number): number {
  return HEADING_BONUS_SHARE / (k + 1);
}

function form(text: string, cjk: boolean): string {
  const s = stemFolded(fold(text));
  return cjk ? s.replace(/\s+/g, '') : s.replace(/\s+/g, ' ');
}

/** True when the heading path holds one of the terms. */
export function headingMatcher(terms: Pick<Term, 'text' | 'kind'>[]): (path: string[]) => boolean {
  const forms = terms.map((t) => {
    const cjk = t.kind === 'cjk' || isMainlyCjk(t.text);
    return { cjk, text: form(t.text, cjk) };
  });
  return (path) => {
    if (!forms.length || !path.length) return false;
    const joined = path.join(' > ');
    const latin = form(joined, false);
    const cjk = form(joined, true);
    return forms.some((f) => f.text && (f.cjk ? cjk : latin).includes(f.text));
  };
}
