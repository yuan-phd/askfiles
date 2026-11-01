import { describe, expect, it } from 'vitest';
import { chunkSections } from './chunk.js';
import { splitKeyOf } from './documents.js';
import { sectionsFromHtml } from './docx.js';
import { joinPageTables, withTables, type Line } from './pdf.js';
import { findPdfTables, formatRow, looksLikeHeader, tableSections, type PdfItem } from './tables.js';
import type { Section, TableData } from './types.js';
import { sheetToTable } from './xlsx.js';

/** A text item at x, y with a width of about 0.5 font sizes per character, like Helvetica. */
const item = (str: string, x: number, y: number, size = 10, width?: number): PdfItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: width ?? str.length * size * 0.5,
  height: size,
});

/** The scoring table of the owner's file 05, page 44, as pdf.js reports it (rounded). */
const scoringTable: PdfItem[] = [
  item('Bid/Proposal Example (using the 0 to 4 scale example above)', 72, 411),
  item('Criteria', 76, 385),
  item('Weighting', 294, 385, 10, 40),
  item('Score', 342, 385, 10, 22),
  item('Weighted Score', 436, 385, 10, 62),
  item('Overall effectiveness of proposed project in delivering', 76, 369, 10, 208),
  item('requirements', 76, 356, 10, 51),
  item('50%', 306, 369, 10, 17),
  item('3', 383, 369, 10, 5),
  item('150', 462, 369, 10, 13),
  item('Methodology for delivering project', 76, 340, 10, 128),
  item('25%', 306, 340, 10, 17),
  item('2', 383, 340, 10, 5),
  item('50', 463, 340, 10, 10),
  item('Quality of team proposed', 76, 325, 10, 94),
  item('15%', 307, 325, 10, 15),
  item('2', 383, 325, 10, 5),
  item('30', 464, 325, 10, 10),
  item('Sustainability', 76, 309, 10, 49),
  item('10%', 307, 309, 10, 15),
  item('1', 384, 309, 10, 3),
  item('10', 464, 309, 10, 8),
  item('Overall Technical Score', 342, 293, 10, 86),
  item('240', 461, 293, 10, 15),
  item('Scoring by Individual Evaluators', 72, 250, 16),
];

describe('findPdfTables', () => {
  it('reads columns, a wrapped cell, the total row and the caption from text positions', () => {
    const [t, ...rest] = findPdfTables(scoringTable, 44);
    expect(rest).toEqual([]);
    expect(t!.table.title).toBe('Bid/Proposal Example (using the 0 to 4 scale example above)');
    expect(t!.table.header).toEqual(['Criteria', 'Weighting', 'Score', 'Weighted Score']);
    expect(t!.table.rows.map((r) => formatRow(r.cells, t!.table.header))).toEqual([
      'Criteria: Overall effectiveness of proposed project in delivering requirements | Weighting: 50% | Score: 3 | Weighted Score: 150',
      'Criteria: Methodology for delivering project | Weighting: 25% | Score: 2 | Weighted Score: 50',
      'Criteria: Quality of team proposed | Weighting: 15% | Score: 2 | Weighted Score: 30',
      'Criteria: Sustainability | Weighting: 10% | Score: 1 | Weighted Score: 10',
      'Overall Technical Score | Weighted Score: 240',
    ]);
  });

  it('assigns the lines of vertically centred cells to the row of their anchor', () => {
    // Two rows of a Chinese specification table: number, name, requirement, a three-line remark.
    const items = [
      item('序号', 70, 748, 9, 18),
      item('指标', 120, 748, 9, 18),
      item('要求', 200, 748, 9, 18),
      item('说明', 300, 748, 9, 18),
      item('采购人根据需要选择', 300, 728, 9, 81),
      item('13', 70, 716, 9, 9),
      item('固态存储容量', 120, 716, 9, 54),
      item('≥240GB', 200, 716, 9, 31),
      item('容量越大越好', 300, 716, 9, 54),
      item('可存储数据越多', 300, 704, 9, 63),
      item('采购人根据需要选择', 300, 692, 9, 81),
      item('15', 70, 686, 9, 9),
      item('机械硬盘总容量', 120, 686, 9, 63),
      item('≥500GB', 200, 686, 9, 31),
      item('容量越大越好', 300, 680, 9, 54),
    ];
    const [t] = findPdfTables(items, 3);
    expect(t!.table.header).toEqual(['序号', '指标', '要求', '说明']);
    expect(t!.table.rows.map((r) => r.cells)).toEqual([
      ['13', '固态存储容量', '≥240GB', '采购人根据需要选择容量越大越好可存储数据越多'],
      ['15', '机械硬盘总容量', '≥500GB', '采购人根据需要选择容量越大越好'],
    ]);
  });

  it('finds nothing in body text, bullet lists or fill-in form lines', () => {
    const body = [
      item('When the evaluation committee has agreed the score to be allocated to each Rated', 72, 469, 10, 432),
      item('Criteria, the scores for each Bid/Proposal are multiplied by the weighting.', 72, 455, 10, 400),
    ];
    const bullets = [
      item('◾', 80, 400, 10, 6),
      item('Pharmaceuticals', 100, 400, 10, 70),
      item('◾', 80, 386, 10, 6),
      item('Vaccines', 100, 386, 10, 40),
      item('◾', 80, 372, 10, 6),
      item('Commodities', 100, 372, 10, 55),
    ];
    const form = [
      item('本招标项目', 90, 600, 12, 60),
      item('（项目名称）已由', 240, 600, 12, 96),
      item('（项目审批机关名称），招标人为', 400, 600, 12, 100),
      item('（招标人名称），项目资金来自', 90, 580, 12, 160),
      item('（资金来源），出资比例为', 300, 580, 12, 130),
      item('。项目已具备招标条件。', 470, 580, 12, 60),
    ];
    expect(findPdfTables(body, 1)).toEqual([]);
    expect(findPdfTables(bullets, 1)).toEqual([]);
    expect(findPdfTables(form, 1)).toEqual([]);
  });

  it('puts the table back as one line among the page lines, the rest of the text kept', () => {
    const lines = withTables(scoringTable, 44);
    expect(lines.map((l) => (l.table ? `[table ${l.table.rows.length}]` : l.text))).toEqual([
      '[table 5]',
      'Scoring by Individual Evaluators',
    ]);
  });
});

describe('joinPageTables', () => {
  const t = (header: string[], cells: string[][], page: number): TableData => ({
    title: '',
    header,
    rows: cells.map((c) => ({ cells: c, page })),
  });
  it('joins a table that goes on after a page break, with or without a repeated header', () => {
    const lines: Line[] = [
      { page: 2, y: 500, size: 9, text: '', table: t(['No', 'Item'], [['1', 'CPU']], 2) },
      { page: 2, y: 60, size: 9, text: '2' },
      { page: 3, y: 740, size: 9, text: '', table: t(['No', 'Item'], [['2', 'RAM']], 3) },
      { page: 4, y: 740, size: 9, text: '', table: t([], [['3', 'SSD']], 4) },
    ];
    const out = joinPageTables(lines);
    expect(out.filter((l) => l.table)).toHaveLength(1);
    expect(out[0]!.table!.rows.map((r) => [r.cells[1], r.page])).toEqual([
      ['CPU', 2],
      ['RAM', 3],
      ['SSD', 4],
    ]);
  });
});

describe('looksLikeHeader', () => {
  it('takes labels and rejects values, sentences and fill-in words', () => {
    expect(looksLikeHeader(['Bidder', 'Weighted Technical Score (80%)'])).toBe(true);
    expect(looksLikeHeader(['序号', '指标分类', '指标要求'])).toBe(true);
    expect(looksLikeHeader(['A', '190'])).toBe(false);
    expect(looksLikeHeader(['BAFO', 'Best and Final Offer.'])).toBe(false);
    expect(looksLikeHeader(['Company A', '240 × Overall Technical Weighting (40%) = 40'])).toBe(false);
    expect(looksLikeHeader(['我方已于', '年', '月'])).toBe(false);
    expect(looksLikeHeader(['Only one'])).toBe(false);
  });
});

describe('tableSections and chunkSections', () => {
  const table: TableData = {
    title: 'Table 2 Limits',
    header: ['City', 'Limit'],
    rows: [
      { cells: ['Beijing', '600'], page: 4 },
      { cells: ['Shanghai', '650'], page: 4 },
      { cells: ['Other', '400'], page: 5 },
    ],
  };
  it('gives a table its own section below the one it stands in, text after it continued', () => {
    const sections: Section[] = [
      {
        title: 'Travel',
        level: 1,
        blocks: [
          { text: 'Before.', page: 4 },
          { text: '', page: 4, table },
          { text: 'After.', page: 5 },
        ],
      },
    ];
    const out = tableSections(sections);
    expect(out.map((s) => `${s.level}:${s.title}`)).toEqual(['1:Travel', '2:Table 2 Limits', '2:Travel (continued)']);
    expect(out[1]!.blocks.map((b) => b.text)).toEqual([
      'City: Beijing | Limit: 600',
      'City: Shanghai | Limit: 650',
      'City: Other | Limit: 400',
    ]);
    expect(out[1]!.table).toEqual({ header: 'City | Limit' });
  });

  it('keeps a headerless table in its section as row lines', () => {
    const plain = { ...table, header: [], title: '' };
    const out = tableSections([{ title: 'Form', level: 1, blocks: [{ text: '', page: 1, table: plain }] }]);
    expect(out).toEqual([
      { title: 'Form', level: 1, blocks: [{ text: 'Beijing | 600\nShanghai | 650\nOther | 400', page: 4 }] },
    ]);
  });

  it('cuts a long table between rows only and repeats the caption and header in every chunk', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      cells: [`City number ${i + 1}`, `${100 + i} yuan per night`],
      page: 1 + Math.floor(i / 30),
    }));
    const chunks = chunkSections(
      [
        {
          title: 'Sheet1',
          level: 1,
          blocks: [{ text: '', page: 1, table: { title: 'Hotel limits', header: ['City', 'Limit'], rows } }],
        },
      ],
      { maxChars: 600 },
    );
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.text.startsWith('Sheet1\nHotel limits\nCity | Limit\n')).toBe(true);
      expect(c.text.length).toBeLessThanOrEqual(600);
      for (const line of c.text.split('\n').slice(3))
        expect(line).toMatch(/^City: City number \d+ \| Limit: \d+ yuan per night$/);
    }
    const all = chunks.flatMap((c) => c.text.split('\n').slice(3));
    expect(all).toHaveLength(60);
    expect(chunks[chunks.length - 1]!.pageEnd).toBe(2);
  });
});

describe('structuredTables in Word and spreadsheets', () => {
  it('Word: header row as labels, caption above as the title', () => {
    const html =
      '<h1>Expenses</h1><p>Rules.</p><p>Table 1 Hotel limits</p>' +
      '<table><tr><td><p>City</p></td><td><p>Limit</p></td></tr><tr><td><p>上海</p></td><td><p>650元</p></td></tr></table>';
    const doc = sectionsFromHtml(html, 'f.docx', { structuredTables: true });
    const out = tableSections(doc.sections);
    expect(out.map((s) => `${s.level}:${s.title}`)).toEqual(['1:Expenses', '2:Table 1 Hotel limits']);
    expect(out[0]!.blocks.map((b) => b.text)).toEqual(['Rules.']);
    expect(out[1]!.blocks.map((b) => b.text)).toEqual(['City: 上海 | Limit: 650元']);
    // Off: the table stays one block of rows in its section, as before.
    expect(sectionsFromHtml(html, 'f.docx').sections[0]!.blocks.map((b) => b.text)).toContain(
      'City | Limit\n上海 | 650元',
    );
  });

  it('spreadsheet: a title row above the header becomes the caption', () => {
    const t = sheetToTable(
      [
        ['台式计算机采购指标', null, null],
        ['序号', '指标', '要求'],
        [13, '固态存储容量', '≥240GB'],
      ],
      1,
    );
    expect(t).toEqual({
      title: '台式计算机采购指标',
      header: ['序号', '指标', '要求'],
      rows: [{ cells: ['13', '固态存储容量', '≥240GB'], page: 1 }],
    });
  });
});

describe('splitKeyOf with indexing switches', () => {
  const base = { splitterVersion: 3, strategy: 'heading', maxChars: 2000, embeddingModel: 'bge-m3:567m' };
  it('is unchanged with every switch off and differs per switch on', () => {
    const off = splitKeyOf(base);
    expect(splitKeyOf({ ...base, indexing: {} })).toBe(off);
    expect(splitKeyOf({ ...base, indexing: { structuredTables: false, cjkHeadings: false, ocrUpscale: false } })).toBe(
      off,
    );
    const keys = new Set([
      off,
      splitKeyOf({ ...base, indexing: { structuredTables: true } }),
      splitKeyOf({ ...base, indexing: { cjkHeadings: true } }),
      splitKeyOf({ ...base, indexing: { ocrUpscale: true } }),
    ]);
    expect(keys.size).toBe(4);
  });
});
