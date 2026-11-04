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
  promptVersionOf,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_PROMPT_VERSION_CJK,
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
    expect(withinCap('员'.repeat(100), 'document')).toBe(true);
    expect(withinCap('员'.repeat(101), 'document')).toBe(false);
    expect(withinCap('员'.repeat(60), 'section')).toBe(true);
    expect(withinCap('员'.repeat(61), 'section')).toBe(false);
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
    expect(system!.content).toContain('Write one or two sentences in Chinese, at most 100 Chinese characters in all.');
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

  it('keeps up to two supported sentences of a Chinese document summary, one for English and for sections', () => {
    const zh = [
      'Title: 报销制度.docx',
      'First section (适用范围):',
      '因公出差、客户招待和培训产生的费用均可按本制度报销。报销申请须在费用发生后30天内提交，逾期不予受理。',
    ].join('\n');
    expect(
      checkSummary('本制度规定因公出差和培训费用的报销。报销申请须在费用发生后30天内提交。另外一句。', zh, 'document'),
    ).toEqual({
      ok: true,
      text: '本制度规定因公出差和培训费用的报销。报销申请须在费用发生后30天内提交。',
    });
    // The unsupported second sentence is left out; the supported first one stays.
    expect(
      checkSummary('本制度规定因公出差和培训费用的报销。员工每年享有带薪年假和住房补贴。', zh, 'document'),
    ).toEqual({
      ok: true,
      text: '本制度规定因公出差和培训费用的报销。',
    });
    expect(checkSummary('员工每年享有带薪年假和住房补贴。公司提供班车。', zh, 'document')).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    // A section summary stays one sentence, as English ones do.
    expect(checkSummary('因公出差的费用可以报销。报销申请须在30天内提交。', zh, 'section')).toEqual({
      ok: true,
      text: '因公出差的费用可以报销。',
    });
    expect(
      checkSummary('The policy gives 27.5 days of paid annual leave. It also covers sick leave.', source, 'document'),
    ).toEqual({ ok: true, text: 'The policy gives 27.5 days of paid annual leave.' });
    expect(cleanSentence('第一句。第二句。第三句。', 2)).toBe('第一句。第二句。');
  });

  it('gives Chinese documents their own prompt version, so only their summaries are made again', () => {
    expect(promptVersionOf(doc('报销制度.docx', [['适用范围', '因公出差的费用均可按本制度报销。']]))).toBe(
      SUMMARY_PROMPT_VERSION_CJK,
    );
    expect(promptVersionOf(doc('Leave.md', [['Annual leave', 'Employees receive 27 days.']]))).toBe(
      SUMMARY_PROMPT_VERSION,
    );
    expect(SUMMARY_PROMPT_VERSION_CJK).not.toBe(SUMMARY_PROMPT_VERSION);
  });
});
