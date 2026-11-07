import { describe, expect, it } from 'vitest';
import type { Claim } from './citations.js';
import { isRuleEcho, splitRuleEchoes } from './rule-echo.js';

const claim = (text: string, citations: number[] = []): Claim => ({ text, citations, unsupported: !citations.length });

describe('ruleEchoRefusal (round V1)', () => {
  it('catches a holdout reply that copies the not-found rule', () => {
    expect(
      isRuleEcho(
        'The sources do not state the specific fact the question asks for, even though they discuss related material: do not answer from related material or from placeholders .',
      ),
    ).toBe(true);
  });

  it('catches the bare marker after a partial answer but not an answer sentence or a remark about the sources', () => {
    expect(isRuleEcho('NOT_IN_SOURCES')).toBe(true);
    expect(isRuleEcho('The Suspension Period lasts ten Business Days.')).toBe(false);
    expect(isRuleEcho('The sources do not specify the exact amount allocated per year.')).toBe(false);
    expect(isRuleEcho('因此，关于公示期的具体时长，资料中没有相关信息。')).toBe(false);
    expect(isRuleEcho('.')).toBe(false);
  });

  it('is a refusal only when nothing with words is left', () => {
    const whole = splitRuleEchoes([
      claim(
        'The sources do not state the specific fact the question asks for: do not answer from related material.',
        [1, 2],
      ),
    ]);
    expect(whole.refusal).toBe(true);
    const partial = splitRuleEchoes([claim('评标资格可暂停。', [2]), claim('NOT_IN_SOURCES', [1, 2])]);
    expect(partial).toMatchObject({ refusal: false, rest: [{ text: '评标资格可暂停。' }] });
    expect(partial.echoes.map((c) => c.text)).toEqual(['NOT_IN_SOURCES']);
    const none = splitRuleEchoes([claim('Leave is 27 days.', [1])]);
    expect(none).toMatchObject({ refusal: false, echoes: [] });
  });
});
