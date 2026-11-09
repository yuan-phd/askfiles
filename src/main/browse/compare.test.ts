import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileRecord } from '../watcher/index.js';
import { BrowseIndex } from './browse-index.js';

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-compare-'))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A browse index over in-memory section documents; sections as [title, level, page, text]. */
function library() {
  const chunks = new Map<string, string>();
  const index = new BrowseIndex({
    dir: path.join(tmp, 'browse'),
    readChunk: (loc) => (chunks.has(loc) ? { pageContent: chunks.get(loc)!, sectionLevel: 1 } : null),
    log: () => {},
  });
  const add = (file: string, sections: [string, number, number, string][]) => {
    sections.forEach(([t, , , body], i) => chunks.set(`${file}-${i}`, `${t}\n${body}`));
    index.update({
      path: file,
      url: `file://${file}`,
      relPath: path.basename(file),
      sourceId: 'files',
      hash: 'h',
      splitKey: 'k',
      size: 10,
      mtimeMs: 1,
      indexedAt: '2026-11-04T00:00:00Z',
      sections: sections.map(([t, level, page], i) => ({
        location: `${file}-${i}`,
        docId: null,
        sectionTitle: t,
        sectionIndex: i + 1,
        sectionLevel: level,
        sectionPath: [t],
        subIndex: 1,
        pageStart: page,
        pageEnd: page,
      })),
    } as unknown as FileRecord);
  };
  return { index, add };
}

describe('Compare groups (BrowseIndex.headings)', () => {
  it('merges page parts and (continued) parts into their parent section, its text in order', () => {
    const { index, add } = library();
    add('/d/bank.pdf', [
      ['Operational Maintenance Matters (page 4)', 2, 4, 'Page four text.'],
      ['Operational Maintenance Matters (page 5)', 2, 5, 'Page five text.'],
      ['Fees', 1, 6, 'Fees before the table.'],
      ['Table 1: Fees', 2, 6, 'Row A 10'],
      ['Fees (continued)', 2, 7, 'Fees after the table.'],
    ]);
    add('/d/agency.pdf', [
      ['Operational Maintenance Matters', 1, 2, 'The agency text.'],
      ['Fees', 1, 3, 'Agency fees.'],
    ]);
    const all = index.headings();
    expect(all.map((g) => [g.label, g.documents, g.entries.length])).toEqual([
      ['Fees', 2, 2],
      ['Operational Maintenance Matters', 2, 2],
    ]);
    const [opm] = index.headings({ key: 'operational maintenance matters' });
    const bank = opm!.entries.find((e) => e.documentTitle === 'bank.pdf')!;
    expect(bank).toMatchObject({ title: 'Operational Maintenance Matters', sectionIndex: 1, pageStart: 4, pageEnd: 5 });
    expect(bank.text).toBe('Page four text.\n\nPage five text.');
    const [fees] = index.headings({ key: 'fees' });
    const bankFees = fees!.entries.find((e) => e.documentTitle === 'bank.pdf')!;
    expect(bankFees).toMatchObject({ sectionIndex: 3, pageStart: 6, pageEnd: 7 });
    expect(bankFees.text).toBe('Fees before the table.\n\nFees after the table.');
  });

  it('gives a document one card per heading: a table section titled like its heading, and the heading used twice', () => {
    const { index, add } = library();
    // As structuredTables writes a section with a table: the heading, its text after the table as
    // (continued), the table as a section titled like the heading, then (continued) again.
    add('/d/club.pdf', [
      ['Garden Words', 2, 3, 'Members are people who paid the fee.'],
      ['Garden Words (continued)', 2, 3, 'Guests are invited by members.'],
      ['Garden Words', 2, 4, 'Term | Meaning'],
      ['Garden Words (continued)', 2, 5, 'Trustees are elected yearly.'],
      ['Meetings', 1, 6, 'Meetings are held monthly.'],
      ['Garden Words', 2, 9, 'A quorum is five members.'],
    ]);
    add('/d/league.pdf', [['Garden Words', 1, 1, 'Teams are clubs that play.']]);
    const [group] = index.headings({ key: 'garden words' });
    expect(group!.documents).toBe(2);
    expect(group!.entries.map((e) => e.documentTitle)).toEqual(['club.pdf', 'league.pdf']);
    const club = group!.entries[0]!;
    expect(club).toMatchObject({ title: 'Garden Words', sectionIndex: 1, pageStart: 3, pageEnd: 9 });
    expect(club.text).toBe(
      [
        'Members are people who paid the fee.',
        'Guests are invited by members.',
        'Term | Meaning',
        'Trustees are elected yearly.',
        'A quorum is five members.',
      ].join('\n\n'),
    );
    // Each part with its own pages; the two parts on page 3 are one.
    expect(club.parts!.map((p) => [p.pageStart, p.pageEnd, p.text])).toEqual([
      [3, 3, 'Members are people who paid the fee.\n\nGuests are invited by members.'],
      [4, 4, 'Term | Meaning'],
      [5, 5, 'Trustees are elected yearly.'],
      [9, 9, 'A quorum is five members.'],
    ]);
    expect(club.display).toBe('club');
    expect(group!.entries[1]!.parts).toHaveLength(1);
    expect(index.headings().find((g) => g.key === 'garden words')).toMatchObject({ documents: 2 });
    expect(index.headings().find((g) => g.key === 'garden words')!.entries).toHaveLength(2);
  });
});
