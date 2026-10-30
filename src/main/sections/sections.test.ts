import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkSections, foldEmptySections, splitToFit } from './chunk.js';
import { directOutlineLevels, headingStyles, levelFromStyleName, sectionsFromHtml } from './docx.js';
import { isAcceptableHeading } from './headings.js';
import { isSupported, parseFile } from './index.js';
import { parseMarkdown } from './markdown.js';
import { encodePng, pdfPageImages } from './pdf-images.js';
import { linesFromItems, marksFromFontSize, sectionsFromMarks, type Line } from './pdf.js';
import { decodeText, parseCsv, parseCsvRows, sheetToText } from './xlsx.js';
import { readZipEntry } from './zip.js';
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
        sectionPath: ['T'],
        subIndex: 1,
        subCount: 1,
        pageStart: 2,
        pageEnd: 2,
        pageLabelStart: '',
        pageLabelEnd: '',
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

describe('heading filter', () => {
  it('keeps plausible headings, numbered or not, Chinese and English', () => {
    for (const t of [
      'Annual leave',
      '2.1 Scope',
      '第一章 总则',
      '第一章',
      'Chapter 3',
      '（一）适用范围',
      'What is covered?',
    ]) {
      expect(isAcceptableHeading(t), t).toBe(true);
    }
  });

  it('rejects long lines, sentences, digits, punctuation and OCR noise', () => {
    for (const t of [
      'x'.repeat(121),
      'Employees get 27 days of paid annual leave per year.',
      '员工每年享有带薪年假。',
      'First, the rules,',
      '3.5 / 12',
      '1.2',
      '--- ** ---',
      'l1| :; ,. 1I',
      'Introduction .......... 3',
      '',
    ]) {
      expect(isAcceptableHeading(t), t).toBe(false);
    }
  });

  it('merges a rejected font-size heading into the body above it', () => {
    const lines: Line[] = [
      { page: 1, y: 700, size: 18, text: 'Chapter' },
      { page: 1, y: 680, size: 11, text: 'Body text that is long enough to be the body size.' },
      { page: 1, y: 660, size: 14, text: 'This large line is a sentence and not a heading.' },
      { page: 1, y: 640, size: 11, text: 'More body text, also body sized and long.' },
    ];
    const marks = marksFromFontSize(lines);
    expect(marks.map((m) => m.title)).toEqual(['Chapter']);
    const sections = sectionsFromMarks(lines, marks, 'doc');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.blocks.map((b) => b.text).join(' ')).toContain('This large line is a sentence');
  });

  it('turns a sentence set in a Word heading style back into body text', () => {
    const doc = sectionsFromHtml(
      '<h1>Rules</h1><p>a</p><h2>Members pay a fee that the board sets.</h2><p>b</p>',
      'f.docx',
    );
    expect(titles(doc.sections)).toEqual(['1:Rules']);
    expect(doc.sections[0]!.blocks.map((b) => b.text)).toEqual(['a', 'Members pay a fee that the board sets.', 'b']);
  });
});

describe('heading hierarchy and page labels', () => {
  it('records the full path of each section from the heading levels, folded headings included', () => {
    const s = (title: string, level: number, text?: string): Section => ({
      title,
      level,
      blocks: text ? [{ text, page: 0 }] : [],
    });
    const chunks = chunkSections(
      [
        s('doc', 0, 'intro'),
        s('1 Leave', 1),
        s('1.1 Sick', 2, 'a'),
        s('1.1.1 Notes', 3, 'b'),
        s('1.2 Annual', 2, 'c'),
        s('2 Pay', 1, 'd'),
      ],
      { maxChars: 1000 },
    );
    expect(chunks.map((c) => [c.sectionTitle, c.sectionLevel, c.sectionPath])).toEqual([
      ['doc', 0, []],
      ['1.1 Sick', 2, ['1 Leave', '1.1 Sick']],
      ['1.1.1 Notes', 3, ['1 Leave', '1.1 Sick', '1.1.1 Notes']],
      ['1.2 Annual', 2, ['1 Leave', '1.2 Annual']],
      ['2 Pay', 1, ['2 Pay']],
    ]);
  });

  it('reads PDF bookmark nesting and printed page labels next to the page index', async () => {
    const doc = await parseFile(path.join(FIXTURES, 'labels.pdf'));
    expect(doc.pageLabels).toEqual(['i', 'ii', '1', '2']);
    const chunks = chunkSections(doc.sections, { maxChars: 1000, pageLabels: doc.pageLabels });
    expect(chunks.map((c) => [c.sectionPath, c.pageStart, c.pageEnd, c.pageLabelStart, c.pageLabelEnd])).toEqual([
      [['Preface'], 1, 2, 'i', 'ii'],
      [['1 Scope'], 3, 3, '1', '1'],
      [['1 Scope', '1.1 Terms'], 4, 4, '2', '2'],
    ]);
  });

  it('gives no labels to a PDF whose labels are just its page numbers', async () => {
    const doc = await parseFile(path.join(FIXTURES, 'eval-s/corpus/it-handbook.pdf'));
    expect(doc.pageLabels).toBeUndefined();
    expect(chunkSections(doc.sections, { maxChars: 1000 })[0]).toMatchObject({ pageLabelStart: '', pageLabelEnd: '' });
  });
});

describe('Word headings', () => {
  it('finds Title, Subtitle, Heading 4 to 6, outline-level styles, based-on styles and direct outline levels', async () => {
    const doc = await parseFile(path.join(FIXTURES, 'headings.docx'));
    expect(titles(doc.sections)).toEqual([
      '1:Club charter',
      '2:Adopted in 2026',
      '1:Preamble',
      '1:Article 1 Name',
      '2:1.1 Members',
      '4:Fees',
      '5:Reduced fee',
      '6:Proof',
      '2:第二条 会议',
    ]);
    // The sentence in a Heading 3 paragraph became body text of 1.1 Members.
    expect(doc.sections[4]!.blocks.map((b) => b.text)).toEqual([
      'Anyone who lives in the district may join.',
      'Members pay a yearly fee that the board sets every January.',
    ]);
    const chunks = chunkSections(doc.sections, { maxChars: 1000 });
    expect(chunks.find((c) => c.sectionTitle === 'Proof')!.sectionPath).toEqual([
      'Article 1 Name',
      '1.1 Members',
      'Fees',
      'Reduced fee',
      'Proof',
    ]);
  });

  it('reads heading levels from styles.xml, following basedOn', () => {
    const W = (id: string, name: string, extra = '') =>
      `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
    const styles = headingStyles(
      W('Normal', 'Normal', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>') +
        W('Heading1', 'heading 1') +
        W('Custom', 'My heading', '<w:basedOn w:val="Heading1"/>') +
        W('Lvl', 'Section head', '<w:pPr><w:outlineLvl w:val="2"/></w:pPr>') +
        W('Body', 'Body', '<w:basedOn w:val="Normal"/>') +
        '<w:style w:type="character" w:styleId="Heading1Char"><w:name w:val="heading 1"/></w:style>',
    );
    expect([...styles.entries()].sort()).toEqual([
      ['Custom', 1],
      ['Heading1', 1],
      ['Lvl', 3],
    ]);
    expect(levelFromStyleName('Title')).toBe(1);
    expect(levelFromStyleName('Subtitle')).toBe(2);
    expect(levelFromStyleName('标题 3')).toBe(3);
    expect(levelFromStyleName('Heading 7')).toBeNull();
  });

  it('lists direct outline levels children first, as mammoth visits paragraphs', () => {
    const xml =
      '<w:body><w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>' +
      '<w:p><w:r><w:txbxContent><w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:p></w:txbxContent></w:r></w:p>' +
      '<w:p/><mc:Choice Requires="wps"><w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:p></mc:Choice></w:body>';
    expect(directOutlineLevels(xml)).toEqual([1, 2, null, null]);
  });
});

describe('spreadsheet types', () => {
  it('reads a macro-enabled workbook (.xlsm) and a legacy one (.xls) like an .xlsx', async () => {
    for (const ext of ['xlsm', 'xls']) {
      const doc = await parseFile(path.join(FIXTURES, `budget-2026.${ext}`));
      expect(doc.outline, ext).toBe('sheets');
      expect(doc.sections.map((s) => s.title)).toEqual(['Budget 2026', 'Headcount']);
      expect(doc.sections[0]!.blocks[0]!.text).toContain('Department: Engineering; Q1: 120000; Q2: 125000');
    }
    expect(isSupported('a.XLSM') && isSupported('b.xls') && isSupported('c.csv')).toBe(true);
  });

  it('reads CSV with quotes, semicolons and GB 18030, keeping leading zeros and long IDs', () => {
    expect(parseCsvRows('a,"b, c","say ""hi"""\r\n1,"two\nlines",3')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', 'two\nlines', '3'],
    ]);
    expect(parseCsvRows('x;y\n1;2')).toEqual([
      ['x', 'y'],
      ['1', '2'],
    ]);
    const doc = parseCsv(Buffer.from('﻿Name,Phone,Amount\nAnna,0123,12345678901234567890\n'), 'staff.csv');
    expect(doc.sections).toEqual([
      {
        title: 'staff',
        level: 1,
        blocks: [{ text: 'Name | Phone | Amount\nName: Anna; Phone: 0123; Amount: 12345678901234567890', page: 1 }],
      },
    ]);
    expect(decodeText(Buffer.from([0xc4, 0xea, 0xbc, 0xd9]))).toBe('年假');
  });
});

describe('zip and PNG helpers', () => {
  it('reads stored and deflated entries and returns null for a missing one', () => {
    const docx = fs.readFileSync(path.join(FIXTURES, 'headings.docx'));
    expect(readZipEntry(docx, 'word/styles.xml')!.toString('utf8')).toContain('Chapter Head');
    expect(readZipEntry(docx, 'word/missing.xml')).toBeNull();
    const xlsm = fs.readFileSync(path.join(FIXTURES, 'budget-2026.xlsm'));
    expect(readZipEntry(xlsm, '[Content_Types].xml')!.toString('utf8')).toContain('macroEnabled');
    expect(() => readZipEntry(Buffer.from('not a zip at all, just text'), 'x')).toThrow('not a zip archive');
  });

  it('encodes gray, RGB and RGBA images as PNG and refuses other kinds', () => {
    const gray = encodePng({ width: 9, height: 2, kind: 1, data: new Uint8Array([0xff, 0x80, 0x00, 0x00]) })!;
    expect(gray.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: width 9, height 2, depth 1, color type 0.
    expect([gray.readUInt32BE(16), gray.readUInt32BE(20), gray[24], gray[25]]).toEqual([9, 2, 1, 0]);
    const rgb = encodePng({ width: 1, height: 1, kind: 2, data: new Uint8Array([1, 2, 3]) })!;
    expect([rgb[24], rgb[25]]).toEqual([8, 2]);
    // A gray scan that pdfjs hands over as RGB is written as 8-bit gray.
    const grayRgb = encodePng({ width: 2, height: 1, kind: 2, data: new Uint8Array([9, 9, 9, 200, 200, 200]) })!;
    expect([grayRgb[24], grayRgb[25]]).toEqual([8, 0]);
    const rgba = encodePng({ width: 1, height: 1, kind: 3, data: new Uint8Array([1, 2, 3, 4]) })!;
    expect([rgba[24], rgba[25]]).toEqual([8, 6]);
    expect(encodePng({ width: 1, height: 1, kind: 9, data: new Uint8Array(4) })).toBeNull();
    expect(encodePng({ width: 4, height: 4, kind: 2, data: new Uint8Array(3) })).toBeNull();
  });

  it('takes the page images out of a scanned PDF, one per page', async () => {
    const pages = [];
    for await (const p of pdfPageImages(fs.readFileSync(path.join(FIXTURES, 'scanned.pdf')))) pages.push(p);
    expect(pages.map((p) => [p.page, p.images.length, p.error])).toEqual([
      [1, 1, undefined],
      [2, 1, undefined],
    ]);
    expect(pages[0]!.images[0]!.readUInt32BE(16)).toBe(1240);
  });
});
