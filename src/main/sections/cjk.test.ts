import { describe, expect, it } from 'vitest';
import { cjkHeading, cjkMarks, cjkSectionsFromBlocks, cleanCjkLines, despace, isCjkText, isFormLine } from './cjk.js';
import { sectionsFromHtml } from './docx.js';
import { sectionsFromMarks, type Line } from './pdf.js';
import { parsePlainText } from './text.js';

const line = (page: number, y: number, text: string, size = 16, x1?: number): Line => ({
  page,
  y,
  size,
  text,
  x0: 90,
  x1: x1 ?? 90 + text.length * size,
});

describe('cjkHeading', () => {
  it('reads every numbering kind at the start of a line', () => {
    expect(cjkHeading('第一章 招标公告')).toMatchObject({ title: '第一章 招标公告', rank: 2 });
    expect(cjkHeading('第二节 通用合同条款')).toMatchObject({ rank: 3 });
    expect(cjkHeading('一、 适用范围')).toMatchObject({ title: '一、 适用范围', rank: 5 });
    expect(cjkHeading('（一）总体要求')).toMatchObject({ rank: 6 });
    expect(cjkHeading('1. 招标条件')).toMatchObject({ rank: 7 });
    expect(cjkHeading('1.1 招标项目概况')).toMatchObject({ rank: 8 });
    expect(cjkHeading('3.7.3 投标文件的份数')).toMatchObject({ rank: 9 });
  });

  it('splits an article number from the sentence it starts', () => {
    expect(cjkHeading('第五条 本规定第二条至第四条规定范围内的项目，其勘察、')).toEqual({
      title: '第五条',
      rest: '本规定第二条至第四条规定范围内的项目，其勘察、',
      rank: 4,
    });
  });

  it('leaves numbered paragraphs, references and years alone', () => {
    expect(cjkHeading('3.2 本次招标接受联合体投标。')).toBeNull();
    expect(cjkHeading('（一）使用预算资金 200 万元人民币以上，并且该资金占投')).toBeNull();
    expect(cjkHeading('第三条的规定，制定本规定。')).toBeNull();
    expect(cjkHeading('第二条、第三条规定情形的')).toBeNull();
    expect(cjkHeading('2018.6 起施行')).toBeNull();
    expect(cjkHeading('第三章“评标办法”前附表应列明全部评审因素，并在本章')).toBeNull();
  });
});

describe('despace and isCjkText', () => {
  it('closes up letter-spaced titles only', () => {
    expect(despace('中 华 人 民 共 和 国')).toBe('中华人民共和国');
    expect(despace('（2017 年版）')).toBe('（2017 年版）');
    expect(despace('Section 1')).toBe('Section 1');
  });
  it('tells Chinese documents from English ones', () => {
    expect(isCjkText('第一条 为了确定必须招标的工程项目')).toBe(true);
    expect(isCjkText('Procurement Regulations for IPF Borrowers, 第一条')).toBe(false);
  });
});

describe('isFormLine', () => {
  it('tells cover form lines from titles with a colon', () => {
    expect(isFormLine('招标人： （盖单位章）')).toBe(true);
    expect(isFormLine('（招标编号： ）')).toBe(true);
    expect(isFormLine('年 月 日')).toBe(true);
    expect(isFormLine('附件：确认通知')).toBe(false);
    expect(isFormLine('使用说明')).toBe(false);
  });
});

describe('cleanCjkLines', () => {
  it('drops page numbers, running headers and contents pages and sorts lines top to bottom', () => {
    const pages = [1, 2, 3, 4];
    const lines: Line[] = pages.flatMap((p) => [
      // pdf.js order: footer first.
      line(p, 74, '国家发展和改革委员会发布', 14),
      line(p, 115, `- ${p} -`, 14),
      line(p, 761, '国家发展和改革委员会行政规范性文件'),
      line(p, 600, `第${'一二三四'[p - 1]}条 正文第${p}页。`),
      line(p, 560, `正文第${p}页的第二行。`),
    ]);
    const contents = ['目 录', ...[1, 2, 3, 4, 5, 6].map((n) => `第${n}章 标题 ........................ ${n + 2}`)];
    lines.push(...contents.map((t, i) => line(5, 700 - i * 20, t, 12)));
    const out = cleanCjkLines(lines);
    expect(out.map((l) => `${l.page}:${l.text}`)).toEqual(
      pages.flatMap((p) => [`${p}:第${'一二三四'[p - 1]}条 正文第${p}页。`, `${p}:正文第${p}页的第二行。`]),
    );
  });
});

describe('cjkMarks', () => {
  it('nests numbered headings by font and numbering, splits articles, joins a wrapped title', () => {
    const lines: Line[] = [
      line(1, 700, '关于印发《招标投标违法行为记录', 22),
      line(1, 670, '公告暂行办法》的通知', 22),
      line(1, 600, '第一章 总则'),
      line(1, 560, '第一条 为了规范招标投标活动，制定本办法。'),
      line(1, 520, '第二条 本办法适用于招标投标活动。'),
      line(1, 480, '一、 适用范围'),
      line(1, 440, '（一）总体要求'),
      line(1, 400, '正文。'),
    ];
    const { marks, lines: out } = cjkMarks(lines);
    expect(marks.map((m) => `${m.level}:${m.title}`)).toEqual([
      '1:关于印发《招标投标违法行为记录公告暂行办法》的通知',
      '2:第一章 总则',
      '3:第一条',
      '3:第二条',
      '4:一、 适用范围',
      '5:（一）总体要求',
    ]);
    const sections = sectionsFromMarks(out, marks, 'f');
    expect(sections.find((s) => s.title === '第一条')!.blocks.map((b) => b.text)).toEqual([
      '为了规范招标投标活动，制定本办法。',
    ]);
  });

  it('does not take the first line of a numbered paragraph for a heading', () => {
    const full = 90 + 24 * 16;
    const lines: Line[] = [
      line(1, 600, '二、 快递包装环保要求'),
      line(1, 570, '1.快递包装中重金属（铅、汞、镉、六价铬）总量应', 16, full),
      line(1, 539, '不大于 100mg/kg；', 16, 300),
      line(1, 508, '2.快递包装印刷使用的油墨中不应添加邻苯二甲酸酯，', 16, full),
      line(1, 477, '其挥发性有机化合物含量应不大于 5%（以重量计）；', 16, full),
      line(1, 446, '本标准中的快递包装主要指快递封装材料，包括封套、', 16, full),
      line(1, 415, '胶带、面单、包装袋、填充物、集装袋、周转箱等。', 16, full),
    ];
    expect(cjkMarks(lines).marks.map((m) => m.title)).toEqual(['二、 快递包装环保要求']);
  });
});

describe('cjkSectionsFromBlocks (Word and plain text)', () => {
  it('makes articles sections when the file has no heading styles', () => {
    const html =
      '<p>必须招标的工程项目规定</p><p>第一条 为了确定必须招标的工程项目，制定本规定。</p><p>第二条 全部使用国有资金的项目包括：</p><p>（一）使用预算资金200万元人民币以上的项目；</p>';
    const doc = sectionsFromHtml(html, '13.docx', { cjkHeadings: true });
    expect(doc.sections.map((s) => `${s.level}:${s.title}`)).toEqual(['0:13', '1:第一条', '1:第二条']);
    expect(doc.sections[2]!.blocks.map((b) => b.text)).toEqual([
      '全部使用国有资金的项目包括：',
      '（一）使用预算资金200万元人民币以上的项目；',
    ]);
    expect(doc.outline).toBe('headings');
    expect(sectionsFromHtml(html, '13.docx').sections.map((s) => s.title)).toEqual(['13']);
  });

  it('leaves English text and documents with heading styles unchanged', () => {
    const en = parsePlainText('1. Scope\n\nThis applies to all staff.', 'a.txt', { cjkHeadings: true });
    expect(en.sections.map((s) => s.title)).toEqual(['a']);
    const styled = [{ title: '总则', level: 1, blocks: [{ text: '第一条 目的。', page: 0 }] }];
    expect(cjkSectionsFromBlocks(styled)).toBe(styled);
  });
});
