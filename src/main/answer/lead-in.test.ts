import { describe, expect, it } from 'vitest';
import type { Claim } from './citations.js';
import { isLeadIn, verifyClaims } from './verify.js';

const claim = (text: string, citations: number[] = []): Claim => ({ text, citations, unsupported: !citations.length });

// Chinese Q18 of the kept configuration's replies: a lead-in, then two cited items.
const q18 = [
  claim('从提供的资料中，屏幕刷新频率和响应耗时的要求如下：\n\n'),
  claim('- 屏幕刷新频率要求为 ≥75Hz \n', [2]),
  claim('- 响应耗时要求为 ≤8ms ', [2]),
];
const passages = ['显示器', '性能指标：刷新频率 ≥75Hz，响应耗时 ≤8ms。'];

describe('leadInExempt (round P1, F1)', () => {
  it('is a lead-in: uncited, ends with a colon, the next sentence with words cites', () => {
    expect(isLeadIn(q18, 0)).toBe(true);
    expect(isLeadIn(q18, 1)).toBe(false);
    // A list marker on its own has no words and is skipped (crossdoc Q56: "...question:", "1. ", cited item).
    const list = [claim('There are 3 items:\n\n'), claim('1. '), claim('The plan is developed early.', [1])];
    expect(isLeadIn(list, 0)).toBe(true);
    // Not when the next sentence with words carries no citation, or there is none, or no colon.
    expect(isLeadIn([claim('The steps are:'), claim('First we check.')], 0)).toBe(false);
    expect(isLeadIn([claim('The steps are:')], 0)).toBe(false);
    expect(isLeadIn([claim('The steps are listed.'), claim('A.', [1])], 0)).toBe(false);
    expect(isLeadIn([claim('The steps are:', [1]), claim('A b.', [1])], 0)).toBe(false);
  });

  it('leaves the lead-in neither cited nor unsupported, and only with the switch', () => {
    const off = verifyClaims(q18, passages, { cjk: true });
    expect(off.claims[0]).toMatchObject({ citations: [], unsupported: true });
    const on = verifyClaims(q18, passages, { cjk: true, leadIn: true });
    expect(on.claims[0]).toMatchObject({ citations: [], unsupported: false, leadIn: true });
    expect(on.stats).toMatchObject({ leadIns: 1, unsupported: 0 });
    expect(on.claims.slice(1).map((c) => c.citations)).toEqual([[2], [2]]);
  });

  it('gives a lead-in no attribution credit even where a source would support it (check Q33)', () => {
    const c = [claim('The sources provide the following three activities:\n\n'), claim('Market research helps.', [1])];
    const p = ['The following three activities help: market research helps.'];
    expect(verifyClaims(c, p).claims[0]).toMatchObject({ citations: [1] });
    expect(verifyClaims(c, p, { leadIn: true }).claims[0]).toMatchObject({ citations: [], leadIn: true });
  });
});
