import { describe, expect, it } from 'vitest';
import { documentName, targetHit } from './answer-metrics.js';

describe('duplicate documents share credit', () => {
  const q = {
    category: 'single_fact',
    expected_source_file: '04_必须招标的工程项目规定.pdf',
    expected_section: '第五条',
    expected_section_path: '',
    key_elements: '400 万元人民币;200 万元人民币',
  } as never;

  it('names one document in two formats alike', () => {
    expect(documentName('04_必须招标的工程项目规定.pdf')).toBe(documentName('13_必须招标的工程项目规定.docx'));
  });

  it('counts the Word copy when its text holds every key element, never a part of it', () => {
    const copy = { file: '13_必须招标的工程项目规定.docx', path: ['第五条'], title: '第五条' };
    expect(targetHit(q, [{ ...copy, passage: '施工单项合同估算价在400万元人民币以上；货物200万元人民币以上。' }])).toBe(
      true,
    );
    expect(targetHit(q, [{ ...copy, passage: '施工单项合同估算价在400万元人民币以上。' }])).toBe(false);
    expect(targetHit(q, [copy])).toBe(false);
    const other = { file: '07_必须招标的基础设施和公用事业项目范围规定.pdf', path: ['第二条'], title: '第二条' };
    expect(targetHit(q, [{ ...other, passage: '400万元人民币 200万元人民币' }])).toBe(false);
  });
});
