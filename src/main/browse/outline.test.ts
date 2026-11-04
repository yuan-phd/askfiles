import { describe, expect, it } from 'vitest';
import { sectionPath } from '../answer/sections.js';
import { buildOutline } from './build.js';
import type { BrowseDocument, BrowseSection, OutlineEntry } from './types.js';

function sec(index: number, title: string, level: number, pages: [number, number], lead: string[] = []): BrowseSection {
  return {
    index,
    title,
    level,
    lead,
    heading: '',
    path: [],
    pageStart: pages[0],
    pageEnd: pages[1],
    pageLabelStart: null,
    pageLabelEnd: null,
    text: `text ${index}`,
    parts: [`text ${index}`],
  };
}

const tree = (es: OutlineEntry[]): unknown[] =>
  es.map((e) => {
    const own = [e.title, e.sectionIndex, e.page, e.pageEnd ?? null, e.parts ?? null];
    return e.children.length ? [...own, tree(e.children)] : own;
  });

describe('buildOutline', () => {
  it('folds the page parts of a long section into one entry with the page range', () => {
    const sections = [
      sec(1, 'Introduction', 2, [1, 1], ['Bank']),
      sec(2, 'Operational Matters (page 2)', 3, [2, 2], ['Operational Matters']),
      sec(3, 'Operational Matters (page 3)', 3, [3, 3]),
      sec(4, 'Operational Matters (page 4)', 3, [4, 5]),
      sec(5, 'Annexes', 2, [6, 6]),
    ];
    expect(tree(buildOutline(sections))).toEqual([
      [
        'Bank',
        1,
        1,
        null,
        null,
        [
          ['Introduction', 1, 1, null, null],
          ['Operational Matters', 2, 2, 5, [2, 3, 4]],
          ['Annexes', 5, 6, null, null],
        ],
      ],
    ]);
  });

  it('folds the text after a table into its section and keeps the table entry', () => {
    const sections = [
      sec(1, 'Fees', 1, [3, 3]),
      sec(2, 'Table 1: Fee schedule', 2, [3, 4]),
      sec(3, 'Fees (continued)', 2, [4, 4]),
      sec(4, 'Payment', 1, [5, 5]),
    ];
    expect(tree(buildOutline(sections))).toEqual([
      ['Fees', 1, 3, 4, [1, 3], [['Table 1: Fee schedule', 2, 3, null, null]]],
      ['Payment', 4, 5, null, null],
    ]);
  });

  it('keeps a part whose section is not in the outline, under its plain title', () => {
    expect(tree(buildOutline([sec(1, 'Rules (page 7)', 2, [7, 7]), sec(2, 'Rules (page 8)', 2, [8, 8])]))).toEqual([
      ['Rules', 1, 7, 8, [1, 2]],
    ]);
  });

  it('gives retrieval the same section paths as the unfolded outline', () => {
    const sections = [
      sec(1, 'Operational Matters (page 1)', 3, [1, 1], ['Bank', 'Operational Matters']),
      sec(2, 'Operational Matters (page 2)', 3, [2, 2]),
    ];
    // Records before section paths existed: the path comes from the outline chain.
    const d = { outline: buildOutline(sections), sections } as unknown as BrowseDocument;
    expect(sectionPath(d, sections[1]!)).toEqual(['Bank', 'Operational Matters', 'Operational Matters (page 2)']);
  });
});
