import { describe, expect, it } from 'vitest';
import type { Claim } from './citations.js';
import { cjkTokens, scoringTokens, STRIP_MIN_TOKENS, verifyClaims } from './verify.js';

const claim = (text: string, citations: number[]): Claim => ({ text, citations, unsupported: false });

// A holdout sentence (docs/plan.md round V2): the sentence's first eleven pairs repeat the question.
const question = '内部配置时，家具本身的抽屉柜最多可以装几个、空置比例上限是多少？装订用的标签纸宽度上限是多少？';
const sentence = '装订用的标签纸宽度上限是不大于 45mm 。';
const passages = [
  '办公家具抽屉不得超过 3 个，空置率不大于 40%。',
  '文具耗材使用的绑绳：宜使用幅宽不大于 45mm 的生物降解绑绳，不得使用含有重元素的涂料。',
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
    const tokens = cjkTokens('装订用的标签纸宽度上限是多少');
    expect(new Set(tokens.filter((t) => !q.has(t))).size).toBeLessThan(STRIP_MIN_TOKENS);
    expect(scoringTokens(tokens, q, true)).toEqual(tokens);
    expect(scoringTokens(cjkTokens(sentence), q, true)).toEqual(['是不', '不大', '大于', '45']);
    expect(scoringTokens(cjkTokens(sentence), q, false)).toEqual(cjkTokens(sentence));
  });
});

describe('verifyStripMin (round P1, F3, measured and not kept)', () => {
  it('scores the holdout sentence on all its pairs when the guard is 5 (four remain)', () => {
    const o = { cjk: true, question: [question], restatement: false, stripQuestion: true } as const;
    expect(verifyClaims([claim(sentence, [2])], passages, o).claims[0]).toMatchObject({ citations: [2] });
    expect(verifyClaims([claim(sentence, [2])], passages, { ...o, stripMin: 5 }).claims[0]).toMatchObject({
      citations: [],
      unsupported: true,
    });
  });
});
