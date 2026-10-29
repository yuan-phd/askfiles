import { describe, expect, it } from 'vitest';
import { findOriginal } from './open-original.js';
import type { FileRecord } from './watcher/index.js';

function rec(p: string, locations: string[] = []): FileRecord {
  return {
    path: p,
    url: `file://${p.split('/').map(encodeURIComponent).join('/')}`,
    hash: 'h',
    splitKey: 'k',
    size: 1,
    mtimeMs: 1,
    indexedAt: '2026-10-29T00:00:00.000Z',
    sections: locations.map((location, i) => ({
      location,
      docId: null,
      sectionTitle: `s${i}`,
      sectionIndex: i + 1,
      subIndex: 1,
      pageStart: null,
      pageEnd: null,
    })),
  };
}

const files = [
  rec('/Users/u/Docs/handbook.pdf', ['askfiles/handbook.pdf-aaa-1-1.json']),
  rec('/Users/u/Docs/2026/budget.xlsx', ['askfiles/budget.xlsx-bbb-1-1.json']),
  rec('/Users/u/Docs/a/notes.md'),
  rec('/Users/u/Docs/b/notes.md'),
  rec('/Users/u/Docs/报销 制度.docx'),
];

describe('findOriginal', () => {
  it('maps the file URL a section document carries', () => {
    expect(findOriginal({ url: files[1]!.url, title: 'budget.xlsx' }, files)).toBe('/Users/u/Docs/2026/budget.xlsx');
    expect(findOriginal({ url: files[4]!.url }, files)).toBe('/Users/u/Docs/报销 制度.docx');
  });

  it('maps a stored document path through the section records', () => {
    expect(findOriginal({ location: 'askfiles/handbook.pdf-aaa-1-1.json' }, files)).toBe('/Users/u/Docs/handbook.pdf');
    expect(findOriginal({ location: 'askfiles\\budget.xlsx-bbb-1-1.json' }, files)).toBe(
      '/Users/u/Docs/2026/budget.xlsx',
    );
  });

  it('maps an upstream upload path by its file name when one indexed file has it', () => {
    const hotdir = 'file:///Users/u/Library/Application%20Support/AskFiles/collector/hotdir/handbook.pdf';
    expect(findOriginal({ url: hotdir, title: 'handbook.pdf' }, files)).toBe('/Users/u/Docs/handbook.pdf');
    expect(findOriginal({ title: 'budget.xlsx' }, files)).toBe('/Users/u/Docs/2026/budget.xlsx');
  });

  it('returns null for an ambiguous name and for anything not in the index', () => {
    expect(findOriginal({ title: 'notes.md' }, files)).toBeNull();
    expect(findOriginal({ url: 'file:///etc/passwd', title: 'passwd' }, files)).toBeNull();
    expect(findOriginal({ url: 'not a url' }, files)).toBeNull();
    expect(findOriginal({}, files)).toBeNull();
  });
});
