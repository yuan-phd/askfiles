import { describe, expect, it } from 'vitest';
import type { Claim } from './citations.js';
import { cjkTokens, scoringTokens, STRIP_MIN_TOKENS, verifyClaims } from './verify.js';

const claim = (text: string, citations: number[]): Claim => ({ text, citations, unsupported: false });

// Holdout H06 (docs/plan.md round V2): the sentence's first eleven pairs repeat the question.
const question = '政府采购时，商品本身的外包装最多可以包几层、空隙比例上限是多少？寄递用的封口带宽度上限是多少？';
const sentence = '寄递用的封口带宽度上限是不大于 45mm 。';
const passages = [
  '商品包装层数不得超过 3 层，空隙率不大于 40%。',
  '快递包装使用的胶带：宜使用幅宽不大于 45mm 的生物降解胶带，不得使用含有重金属的油墨。',
];

describe('verifyStripQuestion (round V2)', () => {
  it('drops the citation on all pairs and keeps it on the pairs the question does not hold', () => {
    const off = verifyClaims([claim(sentence, [2])], passages, { cjk: true, question: [question], restatement: false });
    expect(off.claims[0]).toMatchObject({ citations: [], unsupported: true });
    const on = verifyClaims([claim(sentence, [2])], passages, {
      cjk: true,
      question: [question],
      restatement: false,
      stripQuestion: true,
    });
    expect(on.claims[0]).toMatchObject({ citations: [2], unsupported: false });
    expect(on.claims[0]!.support![0]).toBeCloseTo(0.75, 2);
  });

  it('scores on every token when fewer than three remain after stripping', () => {
    const q = new Set(cjkTokens(question));
    const tokens = cjkTokens('寄递用的封口带宽度上限是多少');
    expect(new Set(tokens.filter((t) => !q.has(t))).size).toBeLessThan(STRIP_MIN_TOKENS);
    expect(scoringTokens(tokens, q, true)).toEqual(tokens);
    expect(scoringTokens(cjkTokens(sentence), q, true)).toEqual(['是不', '不大', '大于', '45']);
    expect(scoringTokens(cjkTokens(sentence), q, false)).toEqual(cjkTokens(sentence));
  });
});

describe('verifyStripMin (round P1, F3, measured and not kept)', () => {
  it('scores H06 on all its pairs when the guard is 5 (four remain)', () => {
    const o = { cjk: true, question: [question], restatement: false, stripQuestion: true } as const;
    expect(verifyClaims([claim(sentence, [2])], passages, o).claims[0]).toMatchObject({ citations: [2] });
    expect(verifyClaims([claim(sentence, [2])], passages, { ...o, stripMin: 5 }).claims[0]).toMatchObject({
      citations: [],
      unsupported: true,
    });
  });
});
