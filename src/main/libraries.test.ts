import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowseIndex, chunkReader, followWatcher } from './browse/index.js';
import {
  checkLibraryName,
  copyInto,
  docsFolderOf,
  filesDir,
  freeName,
  libraryDir,
  LibraryManager,
  linkFolder,
  moveLegacyLibraryFiles,
  type LibrariesView,
} from './libraries.js';
import { emptyShellState, type ShellState } from './shell-state.js';
import { countingSplitter, fakeApi } from './watcher/__fixtures__/fakes.js';
import { chokidarWatch, FolderWatcher } from './watcher/index.js';

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

function setup() {
  let state: ShellState = emptyShellState();
  state.apiKey = 'K';
  state.setupCompletedAt = '2026-10-30T10:00:00.000Z';
  state.libraries[0]!.workspaceSlug = 'askfiles-library';
  const api = fakeApi(storageDir);
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
        splitter: countingSplitter(),
        watch: chokidarWatch,
        debounceMs: 20,
        stableMs: 20,
        log: () => {},
      }),
    createBrowse: (o) => new BrowseIndex({ dir: o.dir, readChunk: chunkReader(storageDir), log: () => {} }),
    followWatcher: (b, w) => followWatcher(b, w),
    onChange: (v) => views.push(v),
    onStatus: () => {},
  });
  return { manager, api, workspaces, views, state: () => state };
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

  it('copies a file under a free name and does not copy the same bytes twice', () => {
    const dir = path.join(tmp, 'files');
    const a = put(path.join(tmp, 'in', 'report.pdf'), 'one');
    const b = put(path.join(tmp, 'other', 'report.pdf'), 'two');
    expect(copyInto(dir, a)).toBe(path.join(dir, 'report.pdf'));
    expect(copyInto(dir, a)).toBeNull();
    expect(copyInto(dir, b)).toBe(path.join(dir, 'report (2).pdf'));
    expect(freeName(dir, 'report.pdf')).toBe('report (3).pdf');
    expect(fs.readFileSync(path.join(dir, 'report (2).pdf'), 'utf8')).toBe('two');
    // The originals are untouched.
    expect(fs.readFileSync(a, 'utf8')).toBe('one');
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
  it('starts with the empty All files library, which cannot be renamed or deleted', async () => {
    const t = setup();
    await t.manager.start();
    const v = t.manager.view();
    expect(v.current).toBe('all-files');
    expect(v.libraries).toEqual([
      { id: 'all-files', name: 'All files', isDefault: true, isCurrent: true, indexed: 0, sources: [] },
    ]);
    expect(t.manager.isEmpty()).toBe(true);
    await expect(t.manager.rename('all-files', 'Mine')).rejects.toThrow('All files cannot be renamed.');
    await expect(t.manager.remove('all-files')).rejects.toThrow('All files cannot be deleted.');
    await t.manager.stop();
  });

  it('adds files by copy and folders by link, indexes them, and removes each source', async () => {
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
    });
    const copy = path.join(filesDir(dataDir, 'all-files'), 'notes.md');
    expect(fs.readFileSync(copy, 'utf8')).toBe(fs.readFileSync(original, 'utf8'));
    await until(() => docTitles(t.manager).length === 2);
    expect(docTitles(t.manager)).toEqual(['leave.md', 'notes.md']);
    expect(
      t.manager
        .browse()!
        .listDocuments()
        .find((d) => d.title === 'leave.md')!.relPath,
    ).toBe(path.join('Documents', 'HR', 'leave.md'));
    const sources = t.manager.view().libraries[0]!.sources;
    expect(sources.map((s) => [s.id, s.kind, s.name])).toEqual([
      ['folder-1', 'folder', 'Documents'],
      ['file:notes.md', 'file', 'notes.md'],
    ]);
    expect(t.manager.isEmpty()).toBe(false);
    expect([...t.api.embedded.keys()].every((l) => l.startsWith(`${docsFolderOf('all-files')}/`))).toBe(true);

    // A second add of the same file is reported, not copied again.
    expect(await t.manager.addPaths([original])).toEqual({
      added: 0,
      skipped: [{ name: 'notes.md', reason: 'already in this library' }],
    });

    await t.manager.removeSource('file:notes.md');
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(original)).toBe(true);
    await until(() => docTitles(t.manager).length === 1);
    await t.manager.removeSource('folder-1');
    await until(() => docTitles(t.manager).length === 0);
    expect(fs.existsSync(path.join(folder, 'HR', 'leave.md'))).toBe(true);
    expect(t.manager.view().libraries[0]!.sources).toEqual([]);
    await expect(t.manager.removeSource('folder-1')).rejects.toThrow(/no longer in this library/);
    await expect(t.manager.removeSource('file:../shell.json')).rejects.toThrow('No such file in this library.');
    await expect(t.manager.removeSource('file:..')).rejects.toThrow('No such file in this library.');
    expect(fs.existsSync(libraryDir(dataDir, 'all-files'))).toBe(true);
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
