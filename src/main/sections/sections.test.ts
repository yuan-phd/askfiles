import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkSections, foldEmptySections, splitToFit } from './chunk.js';
import { sectionsFromHtml } from './docx.js';
import { parseFile } from './index.js';
import { parseMarkdown } from './markdown.js';
import { linesFromItems, marksFromFontSize, sectionsFromMarks, type Line } from './pdf.js';
import { sheetToText } from './xlsx.js';
import type { Section } from './types.js';

const FIXTURES = path.resolve(__dirname, '../../../test/fixtures');
const titles = (sections: Section[]) => sections.map((s) => `${s.level}:${s.title}`);

describe('parseMarkdown', () => {
  it('splits at ATX and setext headings, keeps text before the first heading, ignores fenced code', () => {
    const md = [
      'Intro line.',
      '',
      '# One',
      'Body one.',
      '```',
      '# not a heading',
      '```',
      '',
      'Two',
      '===',
      'Body two.',
      '',
      '## 时间表 ##',
      '第一阶段。',
    ].join('\n');
    const doc = parseMarkdown(md, 'notes.md');
    expect(titles(doc.sections)).toEqual(['0:notes', '1:One', '1:Two', '2:时间表']);
    expect(doc.sections[1]!.blocks.map((b) => b.text)).toEqual(['Body one.\n```\n# not a heading\n```']);
    expect(doc.outline).toBe('headings');
  });
});

describe('sectionsFromHtml (Word)', () => {
  it('reads headings, paragraphs, list items and tables', () => {
    const html =
      '<p>Lead</p><h1>A &amp; B</h1><p>x</p><ul><li>one</li><li>two</li></ul>' +
      '<table><tr><td><p>City</p></td><td><p>Limit</p></td></tr><tr><td><p>上海</p></td><td><p>650元</p></td></tr></table>' +
      '<h2>Empty</h2><h2>C</h2><p>y</p>';
    const doc = sectionsFromHtml(html, 'f.docx');
    expect(titles(doc.sections)).toEqual(['0:f', '1:A & B', '2:Empty', '2:C']);
    expect(doc.sections[1]!.blocks.map((b) => b.text)).toEqual(['x', 'one', 'two', 'City | Limit\n上海 | 650元']);
    expect(doc.sections[2]!.blocks).toEqual([]);
  });

  it('maps Chinese heading style names in a real file', async () => {
    const doc = await parseFile(path.join(FIXTURES, 'eval-s/corpus/报销制度.docx'));
    expect(titles(doc.sections)).toEqual(['1:报销制度', '2:1 适用范围', '2:2 差旅报销', '2:3 提交期限']);
    expect(doc.sections[2]!.blocks.map((b) => b.text)).toContain(
      '城市 | 每晚住宿上限\n北京 | 600元\n上海 | 650元\n其他城市 | 400元',
    );
    expect(doc.sections.every((s) => s.blocks.every((b) => b.page === 0))).toBe(true);
  });

  it('reads three heading levels with English style names', async () => {
    const doc = await parseFile(path.join(FIXTURES, 'eval-l/corpus/operations-manual.docx'));
    expect(titles(doc.sections).slice(0, 4)).toEqual([
      '1:Operations manual 运营手册',
      '2:1 Warehouse',
      '3:1.1 Receiving goods',
      '3:1.2 Storage',
    ]);
  });
});

describe('spreadsheets', () => {
  it('writes header: value pairs when the first row is a text header', () => {
    expect(
      sheetToText([
        ['Department', 'Total', null],
        ['Engineering', 510000, null],
        [null, null, null],
        ['HR', 85000, 'note'],
      ]),
    ).toBe('Department | Total\nDepartment: Engineering; Total: 510000\nDepartment: HR; Total: 85000; note');
  });

  it('joins cells when there is no header', () => {
    expect(
      sheetToText([
        [1, 2],
        [3, 4],
      ]),
    ).toBe('1 | 2\n3 | 4');
  });

  it('gives one section per sheet with the sheet number as page', async () => {
    const doc = await parseFile(path.join(FIXTURES, 'eval-s/corpus/budget-2026.xlsx'));
    expect(doc.outline).toBe('sheets');
    expect(doc.sections.map((s) => [s.title, s.blocks[0]!.page])).toEqual([
      ['Budget 2026', 1],
      ['Headcount', 2],
    ]);
    expect(doc.sections[0]!.blocks[0]!.text).toContain('Department: Engineering; Q1: 120000; Q2: 125000');
  });
});

describe('PDF', () => {
  const item = (str: string, x: number, y: number, size: number, width: number, hasEOL = false) => ({
    str,
    transform: [size, 0, 0, size, x, y],
    width,
    height: size,
    hasEOL,
  });

  it('groups text items into lines, with spaces only between Latin words', () => {
    const lines = linesFromItems(
      [
        item('Hello', 72, 700, 12, 30),
        item('world', 110, 700, 12, 30, true),
        item('你好', 72, 680, 12, 24),
        item('世界', 96, 680, 12, 24),
      ],
      1,
    );
    expect(lines.map((l) => l.text)).toEqual(['Hello world', '你好世界']);
  });

  it('finds headings by font size when there are no bookmarks', () => {
    const lines: Line[] = [
      { page: 1, y: 700, size: 18, text: 'Chapter' },
      { page: 1, y: 680, size: 11, text: 'Body text that is long enough to be the body size.' },
      { page: 1, y: 660, size: 14, text: 'Part' },
      { page: 2, y: 700, size: 11, text: 'More body text on page two, also body sized.' },
    ];
    const marks = marksFromFontSize(lines);
    expect(marks.map((m) => [m.title, m.level])).toEqual([
      ['Chapter', 1],
      ['Part', 2],
    ]);
    const sections = sectionsFromMarks(lines, marks, 'doc');
    expect(sections.map((s) => [s.title, s.blocks.map((b) => [b.text, b.page])])).toEqual([
      ['Chapter', [['Body text that is long enough to be the body size.', 1]]],
      ['Part', [['More body text on page two, also body sized.', 2]]],
    ]);
  });

  it('splits a real file at its bookmarks with pages', async () => {
    const doc = await parseFile(path.join(FIXTURES, 'eval-s/corpus/it-handbook.pdf'));
    expect(doc.outline).toBe('bookmarks');
    expect(doc.sections.map((s) => [s.level, s.title, s.blocks[0]!.page])).toEqual([
      [1, '1 Accounts', 1],
      [1, '2 Laptops', 1],
      [2, '2.1 Lost devices', 2],
      [1, '3 Printing', 2],
    ]);
    expect(doc.sections[0]!.blocks[0]!.text).toMatch(/^Every employee receives one account.*every 90 days/);
  });

  it('reports a PDF without text as needing OCR', async () => {
    const empty =
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
    const { parsePdf } = await import('./pdf.js');
    const doc = await parsePdf(Buffer.from(empty, 'latin1'), 'scan.pdf');
    expect(doc).toMatchObject({ needsOcr: true, sections: [], pages: 1 });
  });
});

describe('foldEmptySections', () => {
  const s = (title: string, ...texts: string[]): Section => ({
    title,
    level: 1,
    blocks: texts.map((text) => ({ text, page: 1 })),
  });

  it('joins a heading without body to the next section as its lead', () => {
    const out = foldEmptySections([s('1 Leave'), s('1.1 Sick leave', 'body')]);
    expect(out).toEqual([{ ...s('1.1 Sick leave', 'body'), lead: ['1 Leave'] }]);
    expect(chunkSections(out, { maxChars: 1000 })[0]!.text).toBe('1 Leave\n1.1 Sick leave\nbody');
  });

  it('joins trailing headings to the previous section', () => {
    expect(foldEmptySections([s('A', 'body'), s('B'), s('C')])).toEqual([s('A', 'body', 'B\nC')]);
  });

  it('never emits a heading-only chunk', () => {
    const chunks = chunkSections([s('A'), s('B')], { maxChars: 1000 });
    expect(chunks).toEqual([]);
  });
});

describe('splitToFit', () => {
  it('keeps every character and respects the limit', () => {
    const text = '第一句话很短。第二句话也不长！Third sentence here. Fourth one 3.5 stays whole. ' + 'x'.repeat(130);
    const parts = splitToFit(text, 40);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => p.length <= 40)).toBe(true);
    expect(parts.slice(0, 3)).toEqual(['第一句话很短。', '第二句话也不长！', 'Third sentence here. ']);
  });
});

describe('chunkSections', () => {
  it('keeps a section that fits as one chunk', () => {
    const chunks = chunkSections([{ title: 'T', level: 1, blocks: [{ text: 'a', page: 2 }] }], { maxChars: 500 });
    expect(chunks).toEqual([
      {
        sectionTitle: 'T',
        sectionIndex: 1,
        sectionLevel: 1,
        subIndex: 1,
        subCount: 1,
        pageStart: 2,
        pageEnd: 2,
        text: 'T\na',
      },
    ]);
  });

  it('cuts a long section into sub-chunks that each carry the title, section index and own pages', () => {
    const para = (n: number, page: number) => ({ text: `Paragraph ${n}. ${'word '.repeat(60).trim()}.`, page });
    const blocks = [para(1, 3), para(2, 3), para(3, 4), para(4, 4), para(5, 5)];
    const chunks = chunkSections(
      [
        { title: 'Short', level: 1, blocks: [{ text: 'x', page: 1 }] },
        { title: 'Long section', level: 2, blocks },
      ],
      { maxChars: 700 },
    );
    const long = chunks.filter((c) => c.sectionIndex === 2);
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((c) => c.text.length <= 700 && c.text.startsWith('Long section\nParagraph'))).toBe(true);
    expect(long.map((c) => [c.subIndex, c.subCount])).toEqual(long.map((_, i) => [i + 1, long.length]));
    expect(long[0]!.pageStart).toBe(3);
    expect(long[long.length - 1]!.pageEnd).toBe(5);
    // Every paragraph appears exactly once.
    const all = long.map((c) => c.text).join('\n');
    for (let n = 1; n <= 5; n++) expect(all.split(`Paragraph ${n}.`).length).toBe(2);
  });

  it('rejects a chunk maximum below the minimum', () => {
    expect(() => chunkSections([], { maxChars: 100 })).toThrow(/at least 400/);
  });

  it('splits the long fixture section for every candidate chunk maximum', async () => {
    const doc = await parseFile(path.join(FIXTURES, 'eval-l/corpus/operations-manual.docx'));
    for (const maxChars of [1500, 2000, 2500]) {
      const chunks = chunkSections(doc.sections, { maxChars });
      const receiving = chunks.filter((c) => c.sectionTitle === '1.1 Receiving goods');
      expect(receiving.length, `maxChars ${maxChars}`).toBeGreaterThan(1);
      expect(chunks.every((c) => c.text.length <= maxChars)).toBe(true);
      expect(receiving[0]!.text.startsWith('1 Warehouse\n1.1 Receiving goods\n')).toBe(true);
    }
  });
});
