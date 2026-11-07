import { describe, expect, it } from 'vitest';
import { claimsOf, parseCitations } from './citations.js';
import {
  cjkTokens,
  contentTokens,
  mainlyCjk,
  VERIFY_MIN_OVERLAP,
  VERIFY_MIN_OVERLAP_CJK,
  verifyClaims,
} from './verify.js';

describe('cjkOverlap', () => {
  it('takes character pairs across the spaces PDF text puts between characters', () => {
    expect(cjkTokens('标 准 设 备，提前 7 日告知')).toEqual(['标准', '准设', '设备', '提前', '7', '日告', '告知']);
    // Without the switch a letter-spaced run gives single characters, which pairs never match.
    expect(contentTokens('标 准 设 备')).toEqual(['标', '准', '设', '备']);
    expect(cjkTokens('ISO 9001 认证')).toEqual(['iso', '9001', '认证']);
  });

  it('tells mainly CJK sentences from English ones', () => {
    expect(mainlyCjk('采购方派员的交通食宿由采购方负担。')).toBe(true);
    expect(mainlyCjk('The Suspension Period lasts ten Calendar Days (第五条).')).toBe(false);
  });

  const passages = [
    '4.1 检查 合同约定开展检查的，供方应提前 7 日将需要检查的事项通知需方，需方派员的交通食宿费用由需方承担。',
    '10. 履约保证金 卖方应保证其履约保证金在买方签收全部合同设备前一直有效。',
  ];
  // A paraphrase from the Chinese set: 0.38 of its pairs are in the section.
  const paraphrase = '采购方派人的交通食宿由采购方负担 [1]。';

  it('keeps a paraphrased Chinese citation that the word measure loses', () => {
    const claims = claimsOf(parseCitations(paraphrase), passages.length);
    const off = verifyClaims(claims, passages);
    expect(off.claims[0]!.unsupported).toBe(true);
    const on = verifyClaims(claims, passages, { cjk: true });
    expect(on.claims[0]).toMatchObject({ citations: [1], unsupported: false });
    expect(VERIFY_MIN_OVERLAP_CJK).toBeLessThan(VERIFY_MIN_OVERLAP);
  });

  it('still fails a Chinese sentence its source does not hold, and leaves English sentences on words', () => {
    const wrong = claimsOf(parseCitations('报销截止时间10日前提出异议，招标人3日内答复 [2]。'), passages.length);
    expect(verifyClaims(wrong, passages, { cjk: true }).claims[0]!.unsupported).toBe(true);
    const en = ['The Suspension Period shall last ten (10) Calendar Days after the notification.'];
    const enClaims = claimsOf(parseCitations('Logs are opened in public at the stated place [1].'), 1);
    expect(verifyClaims(enClaims, en, { cjk: true, cjkMinOverlap: 0 }).claims[0]!.unsupported).toBe(true);
  });
});
