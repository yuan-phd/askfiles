import { describe, expect, it } from 'vitest';
import type { Claim } from './citations.js';
import { cjkTokens, contentTokens, stemTokens, verifyClaims } from './verify.js';

const claim = (text: string, citations: number[]): Claim => ({ text, citations, unsupported: false });

describe('verifyStemEnglish (round P3)', () => {
  it('stems English words only; numbers and CJK pairs stay', () => {
    expect(stemTokens(contentTokens('The exceptions are identified in paragraph 5.80'))).toEqual([
      'except',
      'identifi',
      'paragraph',
      '5.80',
    ]);
    expect(stemTokens(cjkTokens('施工400万元'))).toEqual(cjkTokens('施工400万元'));
  });

  it('a tuning-set sentence: it passes against the Suspension Period clause by stems', () => {
    const passage =
      '5.78 To give Members time to inspect the Announcement and to decide whether to launch a grievance, a Suspension Period shall apply, except in the cases that are set out in Paragraph 5.80.';
    const sentence = 'The exceptions to its application are identified in paragraph 5.80 .';
    const question =
      'According to paragraph 5.78 of the Maintenance Regulations, why is a Suspension Period provided, and which paragraph identifies the exceptions to its application?';
    const o = { question: [question], restatement: false, stripQuestion: true };
    expect(verifyClaims([claim(sentence, [1])], [passage], o).claims[0]).toMatchObject({ unsupported: true });
    expect(verifyClaims([claim(sentence, [1])], [passage], { ...o, stem: true }).claims[0]).toMatchObject({
      citations: [1],
      unsupported: false,
    });
  });

  it('a check-set sentence: brings becomes a question word by its stem, two tokens are left, the guard scores all', () => {
    const table =
      'Criteria: Responsiveness | Weighting: 10% | Score: 1 | Weighted Score: 10\nGeneral Technical Score | Weighted Score: 240';
    const question =
      'In the technical inspection example where the General Technical Score is 240, what are the three weighted scores other than Responsiveness, what is their subtotal, and how does Responsiveness bring the total to 240?';
    const sentence = 'Responsiveness has a weighted score of 10 , which brings the total to 240 (230 + 10) .';
    const o = { question: [question], restatement: false, stripQuestion: true };
    expect(verifyClaims([claim(sentence, [1])], [table], o).claims[0]).toMatchObject({ unsupported: true });
    const on = verifyClaims([claim(sentence, [1])], [table], { ...o, stem: true }).claims[0]!;
    expect(on).toMatchObject({ citations: [1], unsupported: false });
    expect(on.support![0]).toBeCloseTo(0.625, 3);
  });

  it('a Chinese sentence scores the same with and without the switch', () => {
    const c = [claim('差旅单次报销申请额在400万元人民币以上。', [1])];
    const p = ['差旅单次报销申请额在400万元人民币以上的项目必须审批。'];
    expect(verifyClaims(c, p, { cjk: true, stem: true }).claims).toEqual(verifyClaims(c, p, { cjk: true }).claims);
  });
});
