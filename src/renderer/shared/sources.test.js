import { describe, expect, it } from 'vitest';
import {
  filterSources,
  menuSources,
  missingText,
  moreText,
  sameNameFolders,
  sourceKindText,
  sourceMenuText,
  sourceStatusText,
  sourcesCountText,
} from './sources.js';
import { addResultText, replaceQuestion } from './topbar.js';

// Invented sources, shaped like src/main/libraries.ts SourceView.
const folder = (n) => ({
  id: `folder-${n}`,
  kind: 'folder',
  path: `/Users/sam/Folder ${n}`,
  name: `Folder ${n}`,
  available: true,
});
const file = (n) => ({
  id: `file-${n}`,
  kind: 'file',
  path: `/Users/sam/In ${n % 7}/note-${n}.md`,
  name: `note-${n}.md`,
  available: true,
});
const folders = (n) => Array.from({ length: n }, (_, i) => folder(i + 1));
const files = (n) => Array.from({ length: n }, (_, i) => file(i + 1));

describe('library menu rows', () => {
  it('lists every folder, then added files up to five rows, the rest in one row', () => {
    const r = menuSources([...folders(3), ...files(900)]);
    expect(r.rows.map((s) => s.id)).toEqual(['folder-1', 'folder-2', 'folder-3', 'file-1', 'file-2']);
    expect(r.more).toEqual({ folders: 0, files: 898 });
    expect(moreText(r.more)).toBe('898 more files');
  });

  it('lists everything when it fits in five rows', () => {
    expect(menuSources([...folders(3), ...files(2)])).toEqual({ rows: [...folders(3), ...files(2)], more: null });
    expect(menuSources(files(5)).more).toBeNull();
    expect(menuSources([]).rows).toEqual([]);
  });

  it('with five or more folders lists all folders and no added file', () => {
    const r = menuSources([...folders(8), ...files(900)]);
    expect(r.rows).toEqual(folders(8));
    expect(moreText(r.more)).toBe('900 more files');
    expect(menuSources(folders(5)).more).toBeNull();
    expect(moreText(menuSources([...folders(5), file(1)]).more)).toBe('1 more file');
  });

  it('counts folders and files together when both are left out', () => {
    expect(moreText({ folders: 2, files: 3 })).toBe('5 more folders and files');
    expect(moreText({ folders: 1, files: 0 })).toBe('1 more folder');
    expect(moreText(null)).toBe('');
  });
});

describe('folder of same-name files in the menu', () => {
  it('names the parent folder only for listed files and copies that share a name, ignoring case', () => {
    const rows = [
      folder(1),
      { ...file(1), name: 'agenda.md', path: '/Users/sam/Board/agenda.md' },
      { ...file(2), name: 'Agenda.md', path: '/Users/sam/Team/Agenda.md' },
      { id: 'file:agenda.md', kind: 'copy', path: '/data/files/agenda.md', name: 'agenda.md', available: true },
      { ...file(3), name: 'budget.md', path: '/Users/sam/Board/budget.md' },
    ];
    expect([...sameNameFolders(rows)]).toEqual([
      ['file-1', 'Board'],
      ['file-2', 'Team'],
      ['file:agenda.md', 'AskFiles'],
    ]);
    // A folder of the same name as a file does not count; one file of a name gets nothing.
    expect(sameNameFolders([{ ...folder(1), name: 'agenda.md' }, rows[1]]).size).toBe(0);
    expect(sameNameFolders(files(5)).size).toBe(0);
  });
});

describe('Sources section', () => {
  const all = [
    folder(1),
    file(1),
    { ...file(2), available: false },
    {
      id: 'file:old.md',
      kind: 'copy',
      path: '/data/libraries/all-files/files/old.md',
      name: 'old.md',
      available: true,
    },
  ];

  it('names each kind of source and marks those not ok', () => {
    expect(all.map(sourceKindText)).toEqual(['Folder', 'File', 'File', 'Copy']);
    expect(all.map(sourceStatusText)).toEqual(['', '', 'Original missing', '']);
    expect(all.map(sourceMenuText)).toEqual(['Folder', 'File', 'File, original missing', 'Copy']);
    // Out of reach (an unplugged drive): kept and marked Not available, folder or added file.
    const away = [
      { ...folder(1), available: false, status: 'unavailable' },
      { ...file(3), available: false, status: 'unavailable' },
    ];
    expect(away.map(sourceStatusText)).toEqual(['Not available', 'Not available']);
    expect(away.map(sourceMenuText)).toEqual(['Folder, not available', 'File, not available']);
    expect(missingText(away)).toBe('');
    // A view without status (older shape): a folder not available, a file missing.
    expect(sourceStatusText({ ...folder(1), available: false })).toBe('Not available');
  });

  it('searches by name and path, ignoring case', () => {
    expect(filterSources(all, '  ').length).toBe(4);
    expect(filterSources(all, 'NOTE-2').map((s) => s.id)).toEqual(['file-2']);
    expect(filterSources(all, '/in 1/').map((s) => s.id)).toEqual(['file-1']);
    expect(filterSources(all, 'nothing')).toEqual([]);
  });

  it('counts the sources and says when originals are missing', () => {
    expect(sourcesCountText(all)).toBe('1 folder, 2 files, 1 copy');
    expect(sourcesCountText([])).toBe('No sources');
    expect(missingText(all)).toBe('1 original is missing. It leaves the library once AskFiles has checked it.');
    expect(missingText([folder(1)])).toBe('');
  });
});

describe('add result line and replace question', () => {
  it('says a file already in the library is kept up to date', () => {
    expect(addResultText({ added: 0, skipped: [], already: ['plan.md'], conflicts: [], kept: [] })).toBe(
      'Already in this library; it is kept up to date.',
    );
    expect(addResultText({ added: 1, skipped: [], already: ['plan.md'], conflicts: [], kept: [] })).toBe(
      'Added 1 item. plan.md: Already in this library; it is kept up to date.',
    );
    expect(addResultText({ added: 0, skipped: [], already: ['a.md', 'b.md', 'c.md'] })).toBe(
      'a.md and 2 more: already in this library; they are kept up to date.',
    );
  });

  it('says both are kept for a name found in a linked folder', () => {
    expect(
      addResultText({
        added: 1,
        skipped: [],
        already: [],
        kept: [{ name: 'report.md', path: '/Users/sam/Team/Report.md' }],
      }),
    ).toBe(
      'Added 1 item. A file named report.md is already in this library (/Users/sam/Team/Report.md); both will be kept.',
    );
  });

  it('asks replace or keep both with the path of the file already there', () => {
    expect(
      replaceQuestion({
        path: '/b/plan.md',
        name: 'plan.md',
        existing: { id: 'file-1', path: '/a/Plan.md', kind: 'file' },
      }),
    ).toBe('A file named plan.md is already in this library (/a/Plan.md). Replace it, or keep both?');
  });
});
