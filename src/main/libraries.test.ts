import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowseIndex, chunkReader, followWatcher } from './browse/index.js';
import {
  checkLibraryName,
  docsFolderOf,
  filesDir,
  libraryDir,
  LibraryManager,
  linkFolder,
  moveLegacyLibraryFiles,
  type LibrariesView,
} from './libraries.js';
import { emptyShellState, loadShellState, saveShellState, type ShellState } from './shell-state.js';
import { countingSplitter, fakeApi, manualWatch } from './watcher/__fixtures__/fakes.js';
import { chokidarWatch, FolderWatcher, type WatchFactory } from './watcher/index.js';

let tmp: string;
let dataDir: string;
let storageDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-libs-')));
  dataDir = path.join(tmp, 'AskFiles');
  storageDir = path.join(dataDir, 'storage');
  fs.mkdirSync(dataDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function put(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function setup(o: { watch?: WatchFactory; state?: (s: ShellState) => void } = {}) {
  let state: ShellState = emptyShellState();
  state.apiKey = 'K';
  state.setupCompletedAt = '2026-10-30T10:00:00.000Z';
  state.libraries[0]!.workspaceSlug = 'askfiles-library';
  o.state?.(state);
  const api = fakeApi(storageDir);
  const splitter = countingSplitter();
  const workspaces = { ensured: [] as string[], removed: [] as string[] };
  const views: LibrariesView[] = [];
  const manager = new LibraryManager({
    dataDir,
    getState: () => state,
    setState: (s) => (state = structuredClone(s)),
    workspaces: {
      ensure: async (id) => {
        workspaces.ensured.push(id);
        return `ws-${id}`;
      },
      remove: async (slug) => void workspaces.removed.push(slug),
    },
    removeDocuments: (folder) =>
      fs.rmSync(path.join(storageDir, 'documents', folder), { recursive: true, force: true }),
    createWatcher: (o) =>
      new FolderWatcher({
        ...o,
        storageDir,
        api,
        splitter,
        watch: o.watch ?? chokidarWatch,
        debounceMs: 20,
        stableMs: 20,
        log: () => {},
      }),
    createBrowse: (o) => new BrowseIndex({ dir: o.dir, readChunk: chunkReader(storageDir), log: () => {} }),
    followWatcher: (b, w) => followWatcher(b, w),
    onChange: (v) => views.push(v),
    onStatus: () => {},
  });
  return { manager, api, splitter, workspaces, views, state: () => state };
}

const names = (v: LibrariesView) => v.libraries.map((l) => l.name);
const docTitles = (m: LibraryManager) => (m.browse()?.listDocuments() ?? []).map((d) => d.title).sort();

describe('library records', () => {
  it('checks names: trimmed, not empty, at most 60 characters, unique ignoring case', () => {
    const taken = [
      { id: 'all-files', name: 'All files' },
      { id: 'lib-1', name: 'Work' },
    ];
    expect(checkLibraryName('  Home   office ', taken)).toBe('Home office');
    expect(() => checkLibraryName('   ', taken)).toThrow('A library needs a name.');
    expect(() => checkLibraryName('x'.repeat(61), taken)).toThrow(/at most 60/);
    expect(() => checkLibraryName('work', taken)).toThrow('There is already a library called work.');
    expect(checkLibraryName('WORK', taken, 'lib-1')).toBe('WORK');
  });

  it('links folders: refuses one inside a linked folder or around the data, replaces linked ones inside it', () => {
    const at = { dataDir, id: 'folder-9', addedAt: 'now' };
    const docs = path.join(tmp, 'Docs');
    fs.mkdirSync(path.join(docs, 'HR'), { recursive: true });
    const hr = { id: 'folder-1', path: path.join(docs, 'HR'), addedAt: 'then' };
    const r = linkFolder([hr], docs, at);
    expect(r.replaced).toEqual([hr]);
    expect(r.folders.map((f) => [f.id, f.path])).toEqual([['folder-9', docs]]);
    expect(() => linkFolder(r.folders, path.join(docs, 'HR'), at)).toThrow('HR is already in this library.');
    expect(() => linkFolder([], docs + '/', at)).not.toThrow();
    expect(() => linkFolder(r.folders, docs, at)).toThrow('Docs is already in this library.');
    expect(() => linkFolder([], tmp, at)).toThrow(/holds AskFiles data/);
    expect(() => linkFolder([], path.join(dataDir, 'storage'), at)).toThrow(/holds AskFiles data/);
  });

  it('moves the version 1 index and browse folder into the default library', () => {
    put(path.join(dataDir, 'index.json'), '{"version":1,"files":{}}');
    put(path.join(dataDir, 'browse', 'abc.json'), '{}');
    moveLegacyLibraryFiles(dataDir);
    expect(fs.existsSync(path.join(dataDir, 'index.json'))).toBe(false);
    expect(fs.readFileSync(path.join(libraryDir(dataDir, 'all-files'), 'index.json'), 'utf8')).toContain('"files"');
    expect(fs.existsSync(path.join(libraryDir(dataDir, 'all-files'), 'browse', 'abc.json'))).toBe(true);
  });
});

describe('LibraryManager', () => {
  it('creates a library with the chosen profile and changes its record without touching the index', async () => {
    const t = setup();
    await t.manager.start();
    await t.manager.create('Team', 'team-work');
    const lib = t.state().libraries.find((l) => l.name === 'Team')!;
    expect(lib.profile).toBe('team-work');
    expect(t.manager.view().libraries.find((l) => l.name === 'Team')).toMatchObject({ profile: 'team-work' });
    await t.manager.updateRecord(lib.id, (l) => ({
      ...l,
      profile: 'general',
      sectionSummaries: true,
      name: 'ignored',
    }));
    const after = t.state().libraries.find((l) => l.id === lib.id)!;
    expect(after).toMatchObject({ name: 'Team', profile: 'general', sectionSummaries: true });
    expect(t.views.at(-1)!.libraries.find((l) => l.id === lib.id)).toMatchObject({
      profile: 'general',
      sectionSummaries: true,
    });
    await t.manager.stop();
  });

  it('starts with the empty All files library, which cannot be renamed or deleted', async () => {
    const t = setup();
    await t.manager.start();
    const v = t.manager.view();
    expect(v.current).toBe('all-files');
    expect(v.libraries).toEqual([
      {
        id: 'all-files',
        name: 'All files',
        isDefault: true,
        isCurrent: true,
        indexed: 0,
        sources: [],
        profile: 'legal-finance',
        sectionSummaries: false,
      },
    ]);
    expect(t.manager.isEmpty()).toBe(true);
    await expect(t.manager.rename('all-files', 'Mine')).rejects.toThrow('All files cannot be renamed.');
    await expect(t.manager.remove('all-files')).rejects.toThrow('All files cannot be deleted.');
    await t.manager.stop();
  });

  it('links added files and folders, indexes them, and removes each source', async () => {
    const t = setup();
    await t.manager.start();
    const original = put(path.join(tmp, 'Desktop', 'notes.md'), '# Notes\n\nKeep the receipts.');
    const folder = path.join(tmp, 'Documents');
    put(path.join(folder, 'HR', 'leave.md'), '# Leave\n\n27 days a year.');
    put(path.join(tmp, 'Desktop', 'photo.heic'), 'not a document');

    const r = await t.manager.addPaths([original, folder, path.join(tmp, 'Desktop', 'photo.heic'), '/nowhere/x.pdf']);
    expect(r).toEqual({
      added: 2,
      skipped: [
        { name: 'photo.heic', reason: 'not a type AskFiles can read' },
        { name: 'x.pdf', reason: 'not found' },
      ],
      already: [],
      conflicts: [],
      kept: [],
    });
    // Linked, not copied: the library records the original's path and has no folder of copies.
    expect(fs.existsSync(filesDir(dataDir, 'all-files'))).toBe(false);
    expect(t.state().libraries[0]!.files).toEqual([{ id: 'file-1', path: original, addedAt: expect.any(String) }]);
    await until(() => docTitles(t.manager).length === 2);
    expect(docTitles(t.manager)).toEqual(['leave.md', 'notes.md']);
    const docs = t.manager.browse()!.listDocuments();
    expect(docs.find((d) => d.title === 'leave.md')!.relPath).toBe(path.join('Documents', 'HR', 'leave.md'));
    expect(docs.find((d) => d.title === 'notes.md')!.relPath).toBe('notes.md');
    expect(t.manager.watcherOf()!.file(original)).toMatchObject({ sourceId: 'file-1', relPath: 'notes.md' });
    const sources = t.manager.view().libraries[0]!.sources;
    expect(sources.map((s) => [s.id, s.kind, s.name, s.path, s.available])).toEqual([
      ['folder-1', 'folder', 'Documents', folder, true],
      ['file-1', 'file', 'notes.md', original, true],
    ]);
    expect(t.manager.isEmpty()).toBe(false);
    expect([...t.api.embedded.keys()].every((l) => l.startsWith(`${docsFolderOf('all-files')}/`))).toBe(true);

    // The same path again, or a file inside a linked folder: already in, kept up to date.
    expect(await t.manager.addPaths([original, path.join(folder, 'HR', 'leave.md')])).toEqual({
      added: 0,
      skipped: [],
      already: ['notes.md', 'leave.md'],
      conflicts: [],
      kept: [],
    });
    expect(t.state().libraries[0]!.files).toHaveLength(1);

    await t.manager.removeSource('file-1');
    expect(fs.existsSync(original)).toBe(true);
    await until(() => docTitles(t.manager).length === 1);
    expect(t.state().libraries[0]!.files).toEqual([]);
    await t.manager.removeSource('folder-1');
    await until(() => docTitles(t.manager).length === 0);
    expect(fs.existsSync(path.join(folder, 'HR', 'leave.md'))).toBe(true);
    expect(t.manager.view().libraries[0]!.sources).toEqual([]);
    await expect(t.manager.removeSource('folder-1')).rejects.toThrow(/no longer in this library/);
    await expect(t.manager.removeSource('file-1')).rejects.toThrow('No such file in this library.');
    await expect(t.manager.removeSource('file:../shell.json')).rejects.toThrow('No such file in this library.');
    await expect(t.manager.removeSource('file:..')).rejects.toThrow('No such file in this library.');
    expect(fs.existsSync(libraryDir(dataDir, 'all-files'))).toBe(true);

    // Added again after removal: a new id, never the old one; the record survives a save and load.
    await t.manager.addPaths([original]);
    expect(t.state().libraries[0]!.files!.map((f) => f.id)).toEqual(['file-2']);
    saveShellState(dataDir, t.state());
    const loaded = loadShellState(dataDir).libraries[0]!;
    expect(loaded.files).toEqual(t.state().libraries[0]!.files);
    expect(loaded.lastFileId).toBe(2);
    await t.manager.stop();
  });

  it('treats another letter case of an added file on a case-insensitive volume as the same file', async () => {
    const t = setup();
    await t.manager.start();
    const p = put(path.join(tmp, 'Docs', 'Budget.md'), '# Budget\n\nText.');
    await t.manager.addPaths([p]);
    const other = path.join(tmp, 'Docs', 'budget.md');
    // Only where the volume ignores case (the Mac default) does the other spelling exist.
    if (fs.existsSync(other)) expect((await t.manager.addPaths([other])).already).toEqual(['budget.md']);
    expect(t.state().libraries[0]!.files!.map((f) => f.path)).toEqual([p]);
    await t.manager.stop();
  });

  it('follows an added file live: a change is indexed again, a deleted original leaves the library', async () => {
    const t = setup();
    await t.manager.start();
    const desk = path.join(tmp, 'Desktop');
    const added = put(path.join(desk, 'budget.md'), '# Budget\n\nThe first figure.');
    // Other files of the same folder are not part of the library and never indexed.
    put(path.join(desk, 'other.md'), '# Other\n\nNot added.');
    await t.manager.addPaths([added]);
    await until(() => docTitles(t.manager).length === 1);
    const firstHash = t.manager.watcherOf()!.file(added)!.hash;

    fs.writeFileSync(added, '# Budget\n\nThe second figure.');
    put(path.join(desk, 'other.md'), '# Other\n\nChanged, still not added.');
    await until(() => t.manager.watcherOf()!.file(added)?.hash !== firstHash);
    await t.manager.watcherOf()!.whenIdle();
    expect(docTitles(t.manager)).toEqual(['budget.md']);
    const text = t.manager.browse()!.getDocument({ id: t.manager.browse()!.listDocuments()[0]!.id })!;
    expect(JSON.stringify(text)).toContain('The second figure.');
    expect(t.splitter.calls.filter((c) => c.endsWith('other.md'))).toEqual([]);

    // Moved away: removed from the index, then from the library's list of sources.
    fs.renameSync(added, path.join(tmp, 'budget-moved.md'));
    await until(() => (t.state().libraries[0]!.files ?? []).length === 0);
    expect(docTitles(t.manager)).toEqual([]);
    expect(t.api.embedded.size).toBe(0);
    expect(t.manager.isEmpty()).toBe(true);
    await t.manager.stop();
  });

  it('reconciles added files at start: a changed one is indexed again, a deleted one is removed', async () => {
    const t = setup();
    await t.manager.start();
    const a = put(path.join(tmp, 'In', 'a.md'), '# A\n\nOne.');
    const b = put(path.join(tmp, 'Out', 'b.md'), '# B\n\nTwo.');
    await t.manager.addPaths([a, b]);
    await until(() => docTitles(t.manager).length === 2);
    await t.manager.stop();

    fs.writeFileSync(a, '# A\n\nOne, changed while AskFiles was closed.');
    fs.rmSync(b);
    const calls = t.splitter.calls.length;
    await t.manager.start();
    await until(() => (t.state().libraries[0]!.files ?? []).length === 1);
    await t.manager.watcherOf()!.whenIdle();
    expect(docTitles(t.manager)).toEqual(['a.md']);
    expect(t.splitter.calls.slice(calls)).toEqual([a]);
    await t.manager.stop();
  });

  it('asks before adding a file with the name of an added file: replace removes the old one and its data', async () => {
    const t = setup();
    await t.manager.start();
    const old = put(path.join(tmp, 'Old', 'Minutes.md'), '# Minutes\n\nThe old minutes.');
    const fresh = put(path.join(tmp, 'New', 'minutes.md'), '# Minutes\n\nThe new minutes.');
    await t.manager.addPaths([old]);
    await until(() => docTitles(t.manager).length === 1);
    const oldLocations = t.manager
      .watcherOf()!
      .file(old)!
      .sections.map((s) => s.location);

    // Same name ignoring case, another folder: nothing is added until the page answers.
    const asked = await t.manager.addPaths([fresh]);
    expect(asked).toEqual({
      added: 0,
      skipped: [],
      already: [],
      conflicts: [{ path: fresh, name: 'minutes.md', existing: [{ id: 'file-1', path: old, kind: 'file' }] }],
      kept: [],
    });
    expect(t.state().libraries[0]!.files).toHaveLength(1);

    const r = await t.manager.addPaths([fresh], { [fresh]: { action: 'replace', replaces: 'file-1' } });
    expect(r).toMatchObject({ added: 1, conflicts: [] });
    expect(t.state().libraries[0]!.files!.map((f) => f.path)).toEqual([fresh]);
    await until(() => !t.manager.watcherOf()!.file(old) && !!t.manager.watcherOf()!.file(fresh));
    await t.manager.watcherOf()!.whenIdle();
    // The old source's sections, vectors and browse entry are gone; the original file stays.
    for (const l of oldLocations) {
      expect(t.api.embedded.has(l)).toBe(false);
      expect(fs.existsSync(path.join(storageDir, 'documents', l))).toBe(false);
    }
    const docs = t.manager.browse()!.listDocuments();
    expect(docs.map((d) => d.url)).toEqual([pathToFileURL(fresh).href]);
    expect(fs.existsSync(old)).toBe(true);
    await t.manager.stop();
  });

  it('keeps both when asked, and adds a file named like one in a linked folder without asking', async () => {
    const t = setup();
    await t.manager.start();
    const folder = path.join(tmp, 'Shared');
    const inFolder = put(path.join(folder, 'Team', 'Report.md'), '# Report\n\nThe team report.');
    const first = put(path.join(tmp, 'A', 'plan.md'), '# Plan\n\nPlan A.');
    const second = put(path.join(tmp, 'B', 'plan.md'), '# Plan\n\nPlan B.');
    const report = put(path.join(tmp, 'C', 'report.md'), '# Report\n\nMy own report.');
    await t.manager.addPaths([folder, first]);
    await until(() => docTitles(t.manager).length === 2);

    expect((await t.manager.addPaths([second])).conflicts).toHaveLength(1);
    const kept = await t.manager.addPaths([second], { [second]: { action: 'keep' } });
    expect(kept).toMatchObject({ added: 1, conflicts: [] });

    // A linked folder's file: no replace on offer, both are kept and the page says so.
    const r = await t.manager.addPaths([report]);
    expect(r).toEqual({
      added: 1,
      skipped: [],
      already: [],
      conflicts: [],
      kept: [{ name: 'report.md', path: inFolder }],
    });
    await until(() => docTitles(t.manager).length === 4);
    expect(docTitles(t.manager)).toEqual(['Report.md', 'plan.md', 'plan.md', 'report.md']);
    expect(t.state().libraries[0]!.files!.map((f) => [f.id, f.path])).toEqual([
      ['file-1', first],
      ['file-2', second],
      ['file-3', report],
    ]);
    // A stale answer cannot replace a source that is gone.
    const third = put(path.join(tmp, 'D', 'plan.md'), '# Plan\n\nPlan D.');
    expect((await t.manager.addPaths([third], { [third]: { action: 'replace', replaces: 'file-9' } })).skipped).toEqual(
      [{ name: 'plan.md', reason: 'the file to replace is no longer in this library' }],
    );
    await t.manager.stop();
  });

  it('lists every file of the same name in the question, and replaces the one picked', async () => {
    const t = setup();
    await t.manager.start();
    const a = put(path.join(tmp, 'A', 'agenda.md'), '# Agenda\n\nFirst.');
    const b = put(path.join(tmp, 'B', 'Agenda.md'), '# Agenda\n\nSecond.');
    const c = put(path.join(tmp, 'C', 'AGENDA.md'), '# Agenda\n\nThird.');
    const d = put(path.join(tmp, 'D', 'agenda.md'), '# Agenda\n\nFourth.');
    await t.manager.addPaths([a]);
    await t.manager.addPaths([b], { [b]: { action: 'keep' } });
    await t.manager.addPaths([c], { [c]: { action: 'keep' } });
    await until(() => docTitles(t.manager).length === 3);

    const asked = await t.manager.addPaths([d]);
    expect(asked.conflicts).toEqual([
      {
        path: d,
        name: 'agenda.md',
        existing: expect.arrayContaining([
          { id: 'file-1', path: a, kind: 'file' },
          { id: 'file-2', path: b, kind: 'file' },
          { id: 'file-3', path: c, kind: 'file' },
        ]),
      },
    ]);
    expect(asked.conflicts[0]!.existing).toHaveLength(3);

    // The middle one is picked: only it goes, the other two stay.
    await t.manager.addPaths([d], { [d]: { action: 'replace', replaces: 'file-2' } });
    await until(() => !t.manager.watcherOf()!.file(b) && !!t.manager.watcherOf()!.file(d));
    await t.manager.watcherOf()!.whenIdle();
    expect(
      t
        .state()
        .libraries[0]!.files!.map((f) => f.path)
        .sort(),
    ).toEqual([a, c, d].sort());
    expect(docTitles(t.manager)).toEqual(['AGENDA.md', 'agenda.md', 'agenda.md']);
    await t.manager.stop();
  });

  it('keeps sources whose folder is out of reach, marked not available, and clears the mark when back', async () => {
    const t = setup();
    await t.manager.start();
    const drive = path.join(tmp, 'Drive');
    const linked = path.join(drive, 'Shared');
    put(path.join(linked, 'policy.md'), '# Policy\n\nText.');
    const added = put(path.join(drive, 'Loose', 'loose.md'), '# Loose\n\nText.');
    await t.manager.addPaths([linked, added]);
    await until(() => docTitles(t.manager).length === 2);
    await t.manager.watcherOf()!.whenIdle();
    const embedded = t.api.embedded.size;

    // The drive is unplugged (here: renamed away) while AskFiles runs.
    fs.renameSync(drive, path.join(tmp, 'Unplugged'));
    const s = await t.manager.checkUpdates();
    await t.manager.watcherOf()!.whenIdle();
    await new Promise((r) => setTimeout(r, 300));
    expect(s.unavailable.sort()).toEqual([added, linked].sort());
    expect(docTitles(t.manager)).toEqual(['loose.md', 'policy.md']);
    expect(t.api.embedded.size).toBe(embedded);
    const sources = () => t.manager.view().libraries[0]!.sources.map((x) => [x.name, x.status, x.available]);
    expect(sources()).toEqual([
      ['Shared', 'unavailable', false],
      ['loose.md', 'unavailable', false],
    ]);
    expect(t.state().libraries[0]!.files).toHaveLength(1);

    fs.renameSync(path.join(tmp, 'Unplugged'), drive);
    expect((await t.manager.checkUpdates()).unavailable).toEqual([]);
    await t.manager.watcherOf()!.whenIdle();
    expect(sources()).toEqual([
      ['Shared', 'ok', true],
      ['loose.md', 'ok', true],
    ]);
    expect(docTitles(t.manager)).toEqual(['loose.md', 'policy.md']);
    await t.manager.stop();
  });

  it('lists a copy made by an earlier version as Copy, and replaces it when the original is added again', async () => {
    const copies = filesDir(dataDir, 'all-files');
    const copy = put(path.join(copies, 'handbook.md'), '# Handbook\n\nThe copied text.');
    const t = setup();
    await t.manager.start();
    await until(() => docTitles(t.manager).length === 1);
    expect(t.manager.view().libraries[0]!.sources.map((s) => [s.id, s.kind, s.path])).toEqual([
      ['file:handbook.md', 'copy', copy],
    ]);
    const original = put(path.join(tmp, 'Docs', 'Handbook.md'), '# Handbook\n\nThe current text.');
    const asked = await t.manager.addPaths([original]);
    expect(asked.conflicts).toEqual([
      { path: original, name: 'Handbook.md', existing: [{ id: 'file:handbook.md', path: copy, kind: 'copy' }] },
    ]);
    await t.manager.addPaths([original], { [original]: { action: 'replace', replaces: 'file:handbook.md' } });
    expect(fs.existsSync(copy)).toBe(false);
    await until(() => !t.manager.watcherOf()!.file(copy) && !!t.manager.watcherOf()!.file(original));
    expect(t.manager.view().libraries[0]!.sources.map((s) => [s.id, s.kind])).toEqual([['file-1', 'file']]);
    await t.manager.stop();
  });

  it('turns added files inside a newly linked folder into files of that folder', async () => {
    const t = setup();
    await t.manager.start();
    const folder = path.join(tmp, 'Projects');
    const a = put(path.join(folder, 'x', 'a.md'), '# A\n\nText.');
    await t.manager.addPaths([a]);
    await until(() => docTitles(t.manager).length === 1);
    await t.manager.addFolder(folder);
    expect(t.state().libraries[0]!.files).toEqual([]);
    await until(() => t.manager.watcherOf()?.file(a)?.sourceId === 'folder-1');
    expect(docTitles(t.manager)).toEqual(['a.md']);
    await t.manager.stop();
  });

  it('checks for updates: a change no event reported is found, unchanged files are not indexed again', async () => {
    // A watch that never reports anything, like a change made while the event was missed.
    const t = setup({ watch: manualWatch() });
    const folder = path.join(tmp, 'Quiet');
    const changed = put(path.join(folder, 'changed.md'), '# Changed\n\nBefore.');
    put(path.join(folder, 'same.md'), '# Same\n\nNever changes.');
    const added = put(path.join(tmp, 'Single', 'single.md'), '# Single\n\nAlone.');
    await t.manager.start();
    await t.manager.addPaths([folder, added]);
    await until(() => docTitles(t.manager).length === 3);
    await t.manager.watcherOf()!.whenIdle();

    // Nothing changed: up to date, nothing split.
    let calls = t.splitter.calls.length;
    let s = await t.manager.checkUpdates();
    expect(s.state).toBe('idle');
    await t.manager.watcherOf()!.whenIdle();
    expect(t.splitter.calls.length).toBe(calls);

    // A time-only change is looked at by hash and not indexed again.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(folder, 'same.md'), later, later);
    fs.writeFileSync(changed, '# Changed\n\nAfter, never reported.');
    fs.writeFileSync(added, '# Single\n\nAlone, changed too.');
    calls = t.splitter.calls.length;
    s = await t.manager.checkUpdates();
    expect(s.state).toBe('working');
    expect(s.pending).toBe(3);
    await t.manager.watcherOf()!.whenIdle();
    expect(t.splitter.calls.slice(calls).sort()).toEqual([changed, added].sort());
    expect(t.manager.status().state).toBe('idle');
    await t.manager.stop();
  });

  it('reindex removes every document of the workspace and the library, listed or not', async () => {
    const t = setup();
    await t.manager.start();
    const a = put(path.join(tmp, 'Docs', 'a.md'), '# A\n\nText.');
    await t.manager.addPaths([a]);
    await until(() => docTitles(t.manager).length === 1);
    await t.manager.watcherOf()!.whenIdle();
    // A section no record lists: in the workspace and on disk.
    const stray = `${docsFolderOf('all-files')}/stray.md-000000000000-1-1.json`;
    t.api.embedded.set(stray, 'stray-id');
    put(path.join(storageDir, 'documents', stray), '{"pageContent":"stray"}');
    const unembedded = put(path.join(storageDir, 'documents', docsFolderOf('all-files'), 'loose.json'), '{}');

    await t.manager.reindex();
    expect(t.api.embedded.has(stray)).toBe(false);
    expect(fs.existsSync(path.join(storageDir, 'documents', stray))).toBe(false);
    expect(fs.existsSync(unembedded)).toBe(false);
    await until(() => docTitles(t.manager).length === 1);
    await t.manager.watcherOf()!.whenIdle();
    expect([...t.api.embedded.keys()]).toEqual(
      t.manager
        .watcherOf()!
        .file(a)!
        .sections.map((s) => s.location),
    );
    await t.manager.stop();
  });

  it('creates, switches, renames and deletes libraries, each with its own workspace and records', async () => {
    const t = setup();
    await t.manager.start();
    const folder = path.join(tmp, 'Work');
    put(path.join(folder, 'plan.md'), '# Plan\n\nShip it.');

    let v = await t.manager.create('Work');
    const id = v.current;
    expect(id).toMatch(/^lib-[0-9a-f]{6}$/);
    expect(names(v)).toEqual(['All files', 'Work']);
    expect(t.workspaces.ensured).toEqual([id]);
    expect(t.state().libraries[1]).toMatchObject({ id, name: 'Work', workspaceSlug: `ws-${id}`, folders: [] });
    await expect(t.manager.create(' work ')).rejects.toThrow('There is already a library called work.');

    await t.manager.addFolder(folder);
    await until(() => docTitles(t.manager).length === 1);
    expect(fs.existsSync(path.join(libraryDir(dataDir, id), 'index.json'))).toBe(true);
    expect(fs.readdirSync(path.join(storageDir, 'documents', 'askfiles', id)).length).toBeGreaterThan(0);

    v = await t.manager.select('all-files');
    expect(v.current).toBe('all-files');
    expect(docTitles(t.manager)).toEqual([]);
    expect(v.libraries.find((l) => l.id === id)!.indexed).toBe(1);
    await expect(t.manager.select('lib-gone')).rejects.toThrow('That library no longer exists.');

    await t.manager.select(id);
    expect(docTitles(t.manager)).toEqual(['plan.md']);
    v = await t.manager.rename(id, 'Office');
    expect(names(v)).toEqual(['All files', 'Office']);

    v = await t.manager.remove(id);
    expect(v.current).toBe('all-files');
    expect(names(v)).toEqual(['All files']);
    expect(t.workspaces.removed).toEqual([`ws-${id}`]);
    expect(fs.existsSync(libraryDir(dataDir, id))).toBe(false);
    expect(fs.existsSync(path.join(storageDir, 'documents', 'askfiles', id))).toBe(false);
    // The linked folder and its file are the user's and stay.
    expect(fs.existsSync(path.join(folder, 'plan.md'))).toBe(true);
    expect(t.views.length).toBeGreaterThan(0);
    await t.manager.stop();
  });

  it('reindexes the current library: every file split and embedded again', async () => {
    const t = setup();
    await t.manager.start();
    const folder = path.join(tmp, 'Docs');
    put(path.join(folder, 'a.md'), '# A\n\nText.');
    await t.manager.addFolder(folder);
    await until(() => docTitles(t.manager).length === 1);
    const before = t.api.log.length;
    await t.manager.reindex();
    await until(() => docTitles(t.manager).length === 1);
    expect(t.api.log.slice(before)).toEqual(expect.arrayContaining(['remove 1', 'embed +1 -0']));
    await t.manager.stop();
  });

  it('links the preset folder (smoke test) only into an All files library without folders', async () => {
    const t = setup();
    const folder = path.join(tmp, 'Smoke');
    put(path.join(folder, 'x.md'), '# X\n\nY.');
    await t.manager.linkPresetFolder(folder);
    await t.manager.linkPresetFolder(path.join(tmp, 'Other'));
    expect(t.state().libraries[0]!.folders.map((f) => f.path)).toEqual([folder]);
    await t.manager.start();
    await until(() => docTitles(t.manager).length === 1);
    await t.manager.stop();
  });
});
