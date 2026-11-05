import { describe, expect, it } from 'vitest';
import { fuse, MULTI_HIT_SHARE, rrf } from './fusion.js';
import { headingBonus, headingMatcher, HEADING_BONUS_SHARE } from './heading-bonus.js';
import { pathBonus } from './pipeline.js';
import type { Term } from './terms.js';

const t = (text: string, kind: Term['kind'] = 'word'): Term => ({ text, kind, df: 1 });

describe('headingMatcher', () => {
  it('matches English terms by stem as whole words', () => {
    const m = headingMatcher([t('procurement planning', 'pair')]);
    expect(m(['IV', 'PPSD and Procurement Plan', 'Procurement Plan'])).toBe(true);
    expect(m(['Procurement Methods'])).toBe(false);
    expect(headingMatcher([t('plan')])(['Planet Survey'])).toBe(false);
    expect(headingMatcher([t('rated criteria', 'name')])(['VI', 'Market Approach Options', 'Rated Criteria'])).toBe(
      true,
    );
  });

  it('matches a CJK n-gram anywhere in the path, spaces ignored', () => {
    const m = headingMatcher([t('投标保证金', 'cjk')]);
    expect(m(['第二章 投标人须知', '3.4 投 标 保 证 金'])).toBe(true);
    expect(m(['第二章 投标人须知', '3.5 资格审查资料'])).toBe(false);
  });

  it('matches nothing without terms or a path', () => {
    expect(headingMatcher([])(['Procurement Plan'])).toBe(false);
    expect(headingMatcher([t('plan')])([])).toBe(false);
  });
});

describe('heading bonus in fusion', () => {
  const k = 60;
  const v = (section: string) => ({ id: section, text: section, score: 0.5, section });

  it('lifts a matching section over single-list neighbours, once however many terms match', () => {
    const vector = ['a#1', 'b#1', 'c#1'].map(v);
    const plain = fuse(vector, [], k).map((f) => f.key);
    expect(plain).toEqual(['a#1', 'b#1', 'c#1']);
    const lifted = fuse(vector, [], k, (key) => (key === 'c#1' ? headingBonus(k) : 0));
    expect(lifted.map((f) => f.key)).toEqual(['c#1', 'a#1', 'b#1']);
    expect(lifted[0]!.score).toBeCloseTo(rrf(3, k) + HEADING_BONUS_SHARE / (k + 1));
  });

  it('never lifts a single-list section over one both lists rank in their top 16', () => {
    const best = (1 + MULTI_HIT_SHARE) * rrf(1, k) + headingBonus(k);
    expect(2 * rrf(16, k)).toBeGreaterThan(best);
    expect(2 * rrf(17, k)).toBeLessThan(best);
  });

  it('is off without the switch and reads the section path once per key', () => {
    let reads = 0;
    const index = {
      section: (_d: string, i: number) => {
        reads++;
        return { document: {} as never, section: { path: i === 2 ? ['Procurement Plan'] : ['Signing'] } as never };
      },
    };
    expect(pathBonus([t('planning')], { headingPathBonus: false, rrfK: k }, index)).toBeUndefined();
    const b = pathBonus([t('planning')], { headingPathBonus: true, rrfK: k }, index)!;
    expect([b('d#2'), b('d#1'), b('d#2')]).toEqual([headingBonus(k), 0, headingBonus(k)]);
    expect(reads).toBe(2);
  });
});
