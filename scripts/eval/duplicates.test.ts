import { describe, expect, it } from 'vitest';
import { documentName, expectedSections, targetHit } from './answer-metrics.js';

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

describe('alternative expected sections', () => {
  it('accepts either section of an entry written A | B, and nothing else', () => {
    const q = {
      category: 'middle_of_long_doc',
      expected_source_file: '01_标准设备采购招标文件_2017年版.pdf',
      expected_section: '4.2 交货前检验 | 4.1 监造',
      expected_section_path: '',
      key_elements: '提前 7 日',
    } as never;
    expect(expectedSections(q)).toHaveLength(1);
    const at = (title: string, file = '01_标准设备采购招标文件_2017年版.pdf') => [
      { file, path: ['4. 监造及交货前检验', title], title },
    ];
    expect(targetHit(q, at('4.1 监造'))).toBe(true);
    expect(targetHit(q, at('4.2 交货前检验'))).toBe(true);
    expect(targetHit(q, at('4.3 包装'))).toBe(false);
    expect(targetHit(q, at('4.1 监造', '02_标准材料采购招标文件_2017年版.pdf'))).toBe(false);
  });

  it('accepts a section of another file written file :: path (Chinese Q17), and only in that file', () => {
    const q = {
      category: 'table_number',
      expected_source_file: '12_台式计算机政府采购需求标准_2023年版.pdf',
      expected_section: '台式计算机政府采购需求标准（2023 年版）',
      expected_section_path:
        '台式计算机政府采购需求标准（2023 年版） > 台式计算机政府采购需求标准（2023 年版） | 14_台式计算机采购指标摘录_衍生.xlsx :: 采购指标摘录',
      key_elements: '≥2MB;≥2666MT/s',
    } as never;
    expect(expectedSections(q)).toHaveLength(1);
    const pdf = '台式计算机政府采购需求标准（2023 年版）';
    expect(targetHit(q, [{ file: '12_台式计算机政府采购需求标准_2023年版.pdf', path: [pdf, pdf], title: pdf }])).toBe(
      true,
    );
    expect(
      targetHit(q, [{ file: '14_台式计算机采购指标摘录_衍生.xlsx', path: ['采购指标摘录'], title: '采购指标摘录' }]),
    ).toBe(true);
    expect(
      targetHit(q, [
        { file: '12_台式计算机政府采购需求标准_2023年版.pdf', path: ['采购指标摘录'], title: '采购指标摘录' },
      ]),
    ).toBe(false);
  });
});
