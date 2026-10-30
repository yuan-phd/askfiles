import { describe, expect, it } from 'vitest';
import { normalizeHeading } from './normalize.js';

describe('normalizeHeading', () => {
  it('strips numbered prefixes', () => {
    for (const h of [
      '1 Annual leave',
      '1. Annual leave',
      '1.2 Annual leave',
      '1.2.3. Annual leave',
      '3) Annual leave',
    ]) {
      expect(normalizeHeading(h), h).toBe('annual leave');
    }
    expect(normalizeHeading('Chapter 3: Annual leave')).toBe('annual leave');
    expect(normalizeHeading('Section 2.1 Annual leave')).toBe('annual leave');
    expect(normalizeHeading('Part II Annual leave')).toBe('annual leave');
    expect(normalizeHeading('Appendix A - Forms')).toBe('forms');
    expect(normalizeHeading('IV. Annual leave')).toBe('annual leave');
    expect(normalizeHeading('b) Annual leave')).toBe('annual leave');
    expect(normalizeHeading('(a) Annual leave')).toBe('annual leave');
    expect(normalizeHeading('§ 4 Annual leave')).toBe('annual leave');
  });

  it('strips Chinese chapter and list numbering', () => {
    for (const h of [
      '第一章 总则',
      '第一章总则',
      '第12章 总则',
      '一、总则',
      '十一、总则',
      '（一）总则',
      '(一) 总则',
      '1、总则',
      '第二部分 总则',
    ]) {
      expect(normalizeHeading(h), h).toBe('总则');
    }
    expect(normalizeHeading('第一章 1.1 适用范围')).toBe('适用范围');
  });

  it('folds full-width forms and punctuation', () => {
    expect(normalizeHeading('１．２　年假：')).toBe('年假');
    expect(normalizeHeading('Ａｎｎｕａｌ　Ｌｅａｖｅ')).toBe('annual leave');
    expect(normalizeHeading('年假（试行）')).toBe(normalizeHeading('年假(试行)'));
    expect(normalizeHeading('“报销”流程')).toBe('报销 流程');
    expect(normalizeHeading('Leave: Rules & Exceptions')).toBe('leave rules exceptions');
  });

  it('ignores case and whitespace', () => {
    expect(normalizeHeading('ANNUAL  LEAVE')).toBe('annual leave');
    expect(normalizeHeading('  Annual\tLeave ')).toBe('annual leave');
    expect(normalizeHeading('Annual Leave 年假')).toBe('annual leave 年假');
  });

  it('keeps what is not numbering', () => {
    expect(normalizeHeading('2026 Budget')).toBe('2026 budget');
    expect(normalizeHeading('3D printing')).toBe('3d printing');
    expect(normalizeHeading('Part time work')).toBe('part time work');
    expect(normalizeHeading('Mix. Notes')).toBe('mix notes');
  });

  it('keeps a heading that is only numbering apart from other headings', () => {
    expect(normalizeHeading('第一章')).toBe('第一章');
    expect(normalizeHeading('Chapter 1')).toBe('chapter 1');
    expect(normalizeHeading('第一章')).not.toBe(normalizeHeading('第二章'));
  });
});
