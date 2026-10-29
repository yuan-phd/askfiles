import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript client from Session D without type declarations
import { normalizeSource } from '../../renderer/api/client.js';
import { createSourceResolver } from './sources.js';
import type { FileRecord } from './types.js';

// A long section the way upstream sub-splits it: RecursiveCharacterTextSplitter at chunkSize with
// a 20 character overlap, each chunk trimmed, the joins falling on spaces and line breaks.
const sentence = (i: number) => `Rule ${i} of the leave policy applies to every employee of the company.`;
const longSection = '1 Annual leave\n' + Array.from({ length: 40 }, (_, i) => sentence(i)).join('\n');
const shortSection = '2 Expense claims\nClaims are submitted within 30 days.';

function subChunks(text: string, size: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) end = text.lastIndexOf(' ', end);
    out.push(text.slice(start, end).trim());
    start = Math.max(end - 20, start + 1);
    start = text.indexOf(' ', start) + 1 || text.length;
  }
  return out;
}

const header =
  '<document_metadata>\nsourceDocument: handbook.pdf\npublished: 10/29/2026, 7:05:59 AM\n</document_metadata>\n\n';

const files: FileRecord[] = [
  {
    path: '/Users/x/Docs/handbook.pdf',
    url: 'file:///Users/x/Docs/handbook.pdf',
    hash: 'h1',
    splitKey: 'k',
    size: 1,
    mtimeMs: 1,
    indexedAt: '2026-10-29T00:00:00.000Z',
    sections: [
      {
        location: 'askfiles/a-1.json',
        docId: 'd1',
        sectionTitle: '1 Annual leave',
        sectionIndex: 1,
        subIndex: 1,
        pageStart: 1,
        pageEnd: 2,
      },
      {
        location: 'askfiles/a-2.json',
        docId: 'd2',
        sectionTitle: '2 Expense claims',
        sectionIndex: 2,
        subIndex: 1,
        pageStart: 3,
        pageEnd: 3,
      },
    ],
  },
  {
    path: '/Users/x/Docs/notes.md',
    url: 'file:///Users/x/Docs/notes.md',
    hash: 'h2',
    splitKey: 'k',
    size: 1,
    mtimeMs: 1,
    indexedAt: '2026-10-29T00:00:00.000Z',
    sections: [
      {
        location: 'askfiles/b-1.json',
        docId: 'd3',
        sectionTitle: 'Notes',
        sectionIndex: 1,
        subIndex: 1,
        pageStart: null,
        pageEnd: null,
      },
    ],
  },
];
const texts: Record<string, string> = {
  'askfiles/a-1.json': longSection,
  'askfiles/a-2.json': shortSection,
  'askfiles/b-1.json': '# Notes\nshort',
};

describe('createSourceResolver', () => {
  let reads = 0;
  const resolve = createSourceResolver({
    files: () => files,
    readText: (l) => {
      reads++;
      return texts[l] ?? null;
    },
  });

  it('maps every sub-chunk of a long section to that section', () => {
    const chunks = subChunks(longSection, 1000);
    expect(chunks.length).toBeGreaterThan(2);
    // vector-search results as normalizeSource leaves them: header stripped, no section keys.
    const results = chunks.map((c, i) =>
      normalizeSource({ id: `v${i}`, text: header + c, metadata: { url: files[0]!.url, title: 'handbook.pdf' } }),
    );
    expect(results[0].sectionTitle).toBeNull();
    for (const r of resolve(results)) {
      expect(r).toMatchObject({ sectionTitle: '1 Annual leave', sectionIndex: 1, page: 1, pageEnd: 2 });
    }
  });

  it('tells sections of the same file apart by text', () => {
    const [r] = resolve([
      { title: 'handbook.pdf', url: files[0]!.url, text: 'Claims are submitted   within 30 days.' },
    ]);
    expect(r).toMatchObject({ sectionTitle: '2 Expense claims', sectionIndex: 2, page: 3, pageEnd: 3 });
  });

  it('finds the file by name when the url is not one the shell wrote', () => {
    const [r] = resolve([{ title: 'notes.md', url: 'file:///elsewhere/notes.md', text: 'anything' }]);
    expect(r).toMatchObject({ sectionTitle: 'Notes', sectionIndex: 1, page: null, pageEnd: null });
  });

  it('leaves unknown files, unmatched text and already resolved sources alone', () => {
    const unknown = { title: 'other.pdf', url: 'file:///x/other.pdf', text: 'x' };
    const unmatched = { title: 'handbook.pdf', url: files[0]!.url, text: 'text that is in no section' };
    const done = { title: 'handbook.pdf', url: files[0]!.url, text: 'x', sectionTitle: 'Kept', sectionIndex: 9 };
    expect(resolve([unknown, unmatched, done])).toEqual([unknown, unmatched, done]);
  });

  it('reads each section text once', () => {
    const before = reads;
    resolve([{ title: 'handbook.pdf', url: files[0]!.url, text: 'Claims are submitted' }]);
    expect(reads).toBe(before);
  });
});
