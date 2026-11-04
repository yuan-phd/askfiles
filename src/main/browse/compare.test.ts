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
      ['Operational Procurement Matters (page 4)', 2, 4, 'Page four text.'],
      ['Operational Procurement Matters (page 5)', 2, 5, 'Page five text.'],
      ['Fees', 1, 6, 'Fees before the table.'],
      ['Table 1: Fees', 2, 6, 'Row A 10'],
      ['Fees (continued)', 2, 7, 'Fees after the table.'],
    ]);
    add('/d/agency.pdf', [
      ['Operational Procurement Matters', 1, 2, 'The agency text.'],
      ['Fees', 1, 3, 'Agency fees.'],
    ]);
    const all = index.headings();
    expect(all.map((g) => [g.label, g.documents, g.entries.length])).toEqual([
      ['Fees', 2, 2],
      ['Operational Procurement Matters', 2, 2],
    ]);
    const [opm] = index.headings({ key: 'operational procurement matters' });
    const bank = opm!.entries.find((e) => e.documentTitle === 'bank.pdf')!;
    expect(bank).toMatchObject({ title: 'Operational Procurement Matters', sectionIndex: 1, pageStart: 4, pageEnd: 5 });
    expect(bank.text).toBe('Page four text.\n\nPage five text.');
    const [fees] = index.headings({ key: 'fees' });
    const bankFees = fees!.entries.find((e) => e.documentTitle === 'bank.pdf')!;
    expect(bankFees).toMatchObject({ sectionIndex: 3, pageStart: 6, pageEnd: 7 });
    expect(bankFees.text).toBe('Fees before the table.\n\nFees after the table.');
  });
});
