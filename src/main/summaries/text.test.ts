import { describe, expect, it } from 'vitest';
import { doc } from '../graph/__fixtures__/docs.js';
import {
  checkSummary,
  cjkLength,
  cleanSentence,
  documentPrompt,
  documentSource,
  estimateTokens,
  parseBatchReply,
  sectionBatchPrompt,
  withinCap,
  wordCount,
} from './text.js';

const source = [
  'Title: Leave policy.md',
  'Outline: Annual leave; Sick leave',
  'First section (Annual leave):',
  'Permanent employees receive 27 days of paid annual leave per calendar year. Leave is requested in the staff portal.',
].join('\n');

describe('summary text', () => {
  it('counts English words and Chinese characters against the caps', () => {
    expect(wordCount("The policy's 27 days of leave.")).toBe(6);
    expect(cjkLength('员工每年享有27天带薪年假。')).toBe(12);
    const forty = Array.from({ length: 40 }, () => 'word').join(' ') + '.';
    expect(withinCap(forty, 'document')).toBe(true);
    expect(withinCap(`${forty} more`, 'document')).toBe(false);
    expect(withinCap(Array.from({ length: 26 }, () => 'word').join(' '), 'section')).toBe(false);
    expect(withinCap('员'.repeat(50), 'document')).toBe(true);
    expect(withinCap('员'.repeat(51), 'document')).toBe(false);
    expect(withinCap('员'.repeat(36), 'section')).toBe(false);
  });

  it('cleans a reply to its first sentence without labels, quotes or citation marks', () => {
    expect(cleanSentence('Summary: "The policy gives 27 days of leave [1]." It also covers sick leave.')).toBe(
      'The policy gives 27 days of leave.',
    );
    expect(cleanSentence('<think>hmm</think>\n\n- The policy sets leave rules.')).toBe('The policy sets leave rules.');
    expect(cleanSentence('摘要：本制度规定了员工的报销流程。另外还有附件。')).toBe('本制度规定了员工的报销流程。');
  });

  it('keeps a supported summary and drops an unsupported or too long one', () => {
    expect(
      checkSummary(
        'The leave policy gives permanent employees 27 days of paid annual leave per year.',
        source,
        'document',
      ),
    ).toEqual({
      ok: true,
      text: 'The leave policy gives permanent employees 27 days of paid annual leave per year.',
    });
    expect(
      checkSummary('The policy explains pension contributions and company cars for directors.', source, 'document'),
    ).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    const long = `The policy ${'covers leave '.repeat(25)}.`;
    expect(checkSummary(long, source, 'document')).toEqual({ ok: false, reason: 'too-long' });
    expect(checkSummary('  ', source, 'document')).toEqual({ ok: false, reason: 'empty' });
  });

  it('builds the document prompt from title, outline and first section, in Chinese for a Chinese text', () => {
    const d = doc('报销制度.docx', [
      ['适用范围', '因公出差、客户招待和培训产生的费用均可按本制度报销。'],
      ['提交期限', '报销申请须在费用发生后30天内提交。'],
    ]);
    const src = documentSource(d);
    expect(src.section!.index).toBe(1);
    expect(src.text).toContain('Outline: 适用范围; 提交期限');
    const [system, user] = documentPrompt(d);
    expect(system!.content).toContain('in Chinese, at most 50 Chinese characters');
    expect(user!.content).toBe(src.text);
    expect(documentPrompt(doc('a.md', [['A', 'An English text about leave.']]))[0]!.content).toContain(
      'in English, at most 40 words',
    );
  });

  it('builds one numbered prompt for several sections and reads the numbered reply back', () => {
    const d = doc('Leave policy.md', [
      ['Annual leave', 'Employees receive 27 days.'],
      ['Sick leave', 'Call the manager on the first day.'],
    ]);
    const [system, user] = sectionBatchPrompt(d, d.sections);
    expect(system!.content).toContain('Reply with exactly 2 lines');
    expect(system!.content).toContain('Write each sentence in English, at most 25 words.');
    expect(user!.content).toBe(
      'Document: Leave policy.md\n\n[1] Section: Annual leave\nEmployees receive 27 days.\n\n[2] Section: Sick leave\nCall the manager on the first day.',
    );
    const r = parseBatchReply(
      '<think>x</think>Here you go:\n1. Employees get 27 days.\n**2.** Staff call in sick.\n2. A repeat.\n9. Out of range.',
      2,
    );
    expect([...r]).toEqual([
      [1, 'Employees get 27 days.'],
      [2, 'Staff call in sick.'],
    ]);
    expect([...parseBatchReply('1、员工享有年假。\n[2] 病假须报告。', 2).values()]).toEqual([
      '员工享有年假。',
      '病假须报告。',
    ]);
    expect(estimateTokens('abcd员工')).toBe(3);
  });
});
