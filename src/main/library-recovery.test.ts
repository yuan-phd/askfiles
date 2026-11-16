import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirstRun, type WizardLike } from './first-run.js';
import { startupLibraryCheck } from './library-data.js';
import { finishRestore, openShellState, shouldFinishRestore, type OpenedShellState } from './library-recovery.js';
import type { Preset } from './presets/index.js';
import {
  clearSelfCheckHold,
  emptyShellState,
  LIBRARY_RECORD_FILE,
  readSelfCheckHold,
  readShellState,
  saveShellState,
  SELF_CHECK_HOLD,
  SHELL_STATE_BACKUP,
  SHELL_STATE_FILE,
  type ShellState,
} from './shell-state.js';
import type { WizardSnapshot } from './wizard/index.js';

// Everything here is invented: paths, names, keys and text.
let tmp: string;
let dataDir: string;
let storageDir: string;
let logs: string[];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-recovery-')));
  dataDir = path.join(tmp, 'AskFiles');
  storageDir = path.join(dataDir, 'storage');
  fs.mkdirSync(dataDir, { recursive: true });
  logs = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const log = (m: string) => logs.push(m);
const file = () => path.join(dataDir, SHELL_STATE_FILE);
const backup = () => path.join(dataDir, SHELL_STATE_BACKUP);
const libDir = (id: string) => path.join(dataDir, 'libraries', id);

function put(p: string, text = '{}'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function record(p: string, relPath: string, sourceId: string, indexedAt = '2026-11-02T10:00:00.000Z') {
  return {
    path: p,
    url: `file://${p}`,
    relPath,
    sourceId,
    hash: 'a'.repeat(64),
    splitKey: 'k',
    size: 1,
    mtimeMs: 1,
    indexedAt,
    sections: [{ location: `askfiles/x/${path.basename(p)}.json` }],
  };
}

function index(records: ReturnType<typeof record>[]): string {
  return JSON.stringify({ version: 1, files: Object.fromEntries(records.map((r) => [r.path, r])) });
}

const HANDBOOK = '/Users/tester/Invented Handbook';
const BOARD = '/Users/tester/Board Papers';

/**
 * A data folder with four libraries' data and no shell.json:
 * - all-files: a linked folder, an added file and a copy of an earlier version, no library.json
 *   (as written before this change)
 * - lib-0a0a0a: a linked folder and graph.json with the team-work kind, no library.json
 * - lib-0b0b0b: library.json with its name, kind and workspace
 * - lib-0c0c0c: only its section documents
 */
function makeData(): void {
  put(
    path.join(libDir('all-files'), 'index.json'),
    index([
      record(`${HANDBOOK}/guide.md`, 'Invented Handbook/guide.md', 'folder-1', '2026-11-01T09:00:00.000Z'),
      record(`${HANDBOOK}/rules/fees.md`, 'Invented Handbook/rules/fees.md', 'folder-1'),
      record('/Users/tester/Desktop/plan.pdf', 'plan.pdf', 'file-2'),
      record(path.join(libDir('all-files'), 'files', 'old.md'), 'old.md', 'files'),
    ]),
  );
  put(path.join(libDir('all-files'), 'files', 'old.md'), '# Copy');
  put(
    path.join(libDir('lib-0a0a0a'), 'index.json'),
    index([record(`${BOARD}/2026/minutes.md`, 'Board Papers/2026/minutes.md', 'folder-1', '2026-11-03T08:00:00.000Z')]),
  );
  put(path.join(libDir('lib-0a0a0a'), 'graph.json'), JSON.stringify({ version: 1, profile: { id: 'team-work' } }));
  put(path.join(libDir('lib-0b0b0b'), 'index.json'), index([]));
  put(
    path.join(libDir('lib-0b0b0b'), LIBRARY_RECORD_FILE),
    JSON.stringify({
      id: 'lib-0b0b0b',
      name: 'Invented Projects',
      workspaceSlug: 'askfiles-lib-0b0b0b',
      folders: [{ id: 'folder-1', path: '/Users/tester/Projects', addedAt: '2026-11-04T08:00:00.000Z' }],
      createdAt: '2026-11-04T07:00:00.000Z',
      profile: 'general',
    }),
  );
  put(path.join(storageDir, 'documents', 'askfiles', 'lib-0c0c0c', 'doc-1.json'), '{"pageContent":"Invented."}');
  for (const id of ['all-files', 'lib-0a0a0a', 'lib-0b0b0b'])
    put(path.join(storageDir, 'documents', 'askfiles', id, 'doc-1.json'), '{"pageContent":"Invented."}');
  put(path.join(storageDir, 'lancedb', 'askfiles-lib-0a0a0a.lance', 'data'));
  put(path.join(dataDir, 'server', '.env'), 'INVENTED=1');
}

/** Every file of the libraries' data and storage (not shell.json and its companions). */
function libraryData(): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name !== LIBRARY_RECORD_FILE) out.push(path.relative(dataDir, p));
    }
  };
  for (const d of [path.join(dataDir, 'libraries'), storageDir]) if (fs.existsSync(d)) visit(d);
  return out.sort();
}

const open = () => openShellState({ dataDir, storageDir, log, now: () => new Date('2026-11-16T07:00:00.000Z') });

async function check(read: OpenedShellState, state: ShellState = read.state) {
  return startupLibraryCheck({
    source: read.source,
    resumeRemovals: async () => [],
    dataDir,
    storageDir,
    state,
    knownIds: read.knownIds,
    hold: read.hold,
    liftHold: () => clearSelfCheckHold(dataDir),
    listWorkspaces: async () => [
      { name: 'askfiles-library', slug: 'askfiles-library' },
      { name: 'askfiles-lib-0a0a0a', slug: 'askfiles-lib-0a0a0a' },
      { name: 'askfiles-lib-0b0b0b', slug: 'askfiles-lib-0b0b0b' },
    ],
    removeWorkspace: async (slug) => {
      throw new Error(`no workspace may go, asked for ${slug}`);
    },
    log,
  });
}

/** The first run as the app makes it, with a wizard that is already done. */
async function firstRun(load: () => ShellState, save: (s: ShellState) => void): Promise<void> {
  const preset = { id: '32gb' } as Preset;
  const snapshot = { state: 'done', tier: { preset } } as unknown as WizardSnapshot;
  const wizard: WizardLike = {
    start: async () => snapshot,
    retry: async () => snapshot,
    snapshot: () => snapshot,
    on: () => undefined,
  };
  const run = new FirstRun({
    wizard,
    loadState: load,
    saveState: save,
    setupLibrary: async () => ({ apiKey: 'INVENTED-NEW-KEY', workspaceSlug: 'askfiles-library' }),
  });
  const done = await run.start();
  expect(done.state).toBe('done');
}

describe('a damaged shell.json and no backup', () => {
  it('rebuilds every library from its folders, sets the hold and saves', () => {
    makeData();
    put(file(), '{"version": 2, "libraries": [ junk');
    const r = open();

    expect(r.source).toBe('unreadable');
    expect(r.restored).toBe(true);
    expect(r.hold).toMatchObject({
      reason: 'shell.json unreadable',
      unnamed: ['lib-0a0a0a', 'lib-0b0b0b', 'lib-0c0c0c'],
    });
    expect(readSelfCheckHold(dataDir)).not.toBeNull();
    const libs = r.state.libraries;
    expect(libs.map((l) => [l.id, l.name])).toEqual([
      ['all-files', 'All files'],
      ['lib-0a0a0a', 'Recovered library 1'],
      ['lib-0b0b0b', 'Invented Projects'],
      ['lib-0c0c0c', 'Recovered library 2'],
    ]);
    expect(libs[0]).toMatchObject({
      folders: [{ id: 'folder-1', path: HANDBOOK, addedAt: '2026-11-01T09:00:00.000Z' }],
      files: [{ id: 'file-2', path: '/Users/tester/Desktop/plan.pdf' }],
      lastFileId: 2,
      workspaceSlug: null,
    });
    expect(libs[1]).toMatchObject({
      profile: 'team-work',
      folders: [{ id: 'folder-1', path: BOARD }],
      createdAt: '2026-11-03T08:00:00.000Z',
    });
    expect(libs[2]).toMatchObject({
      profile: 'general',
      workspaceSlug: 'askfiles-lib-0b0b0b',
      folders: [{ path: '/Users/tester/Projects' }],
    });
    expect(libs[3]).toMatchObject({ folders: [], workspaceSlug: null });
    expect([...r.knownIds].sort()).toEqual(['all-files', 'lib-0a0a0a', 'lib-0b0b0b', 'lib-0c0c0c']);

    // Saved at once, so a quit before anything else keeps the rebuilt libraries.
    expect(readShellState(dataDir).state.libraries.map((l) => l.id)).toEqual(libs.map((l) => l.id));
    expect(logs).toContain('[recovery] lib-0a0a0a: kind team-work from graph.json');
    expect(logs).toContain('[recovery] lib-0b0b0b: record rebuilt from library.json');
    expect(logs).toContain('[recovery] lib-0c0c0c: only its section documents are left, no sources rebuilt');
    expect(logs).toContain('[recovery] all-files: 1 folders and 1 added files from index.json');
    expect(logs.some((l) => l.startsWith('[recovery] 4 libraries rebuilt'))).toBe(true);
    expect(logs.some((l) => l.startsWith('[self-check] held: shell.json unreadable'))).toBe(true);
  });

  it('two starts with the first run between them delete nothing, and the hold lifts once every library is named', async () => {
    makeData();
    put(file(), 'junk');
    const before = libraryData();

    // Start 1: rebuilt, no self-check.
    const r1 = open();
    let state: ShellState = r1.state;
    expect(await check(r1)).toBe('skipped');
    // The first run saves (as it would when the server settings were missing).
    await firstRun(
      () => state,
      (s) => {
        saveShellState(dataDir, s);
        state = s;
      },
    );
    expect(readShellState(dataDir).state.libraries).toHaveLength(4);

    // Start 2: shell.json reads and names every library: the hold lifts and the self-check runs.
    logs = [];
    const r2 = open();
    expect(r2.source).toBe('file');
    expect(r2.hold?.unnamed).toEqual([]);
    expect(await check(r2)).toBe('done');
    expect(logs.some((l) => l.includes('lifted: shell.json names every library folder'))).toBe(true);
    expect(logs).toContain('[self-check] nothing to remove');
    expect(readSelfCheckHold(dataDir)).toBeNull();
    expect(libraryData()).toEqual(before);
  });

  it('a save that drops a library after the reset cannot make its data look unused', async () => {
    makeData();
    put(file(), 'junk');
    const before = libraryData();
    const r1 = open();
    expect(await check(r1)).toBe('skipped');
    // The worst case: something saves a state with All files only (the bug this guards against).
    const dropped = emptyShellState();
    dropped.apiKey = 'INVENTED-NEW-KEY';
    dropped.setupCompletedAt = '2026-11-16T07:01:00.000Z';
    dropped.libraries[0]!.workspaceSlug = 'askfiles-library';
    saveShellState(dataDir, dropped);

    // Start 2: shell.json reads fine but does not name three library folders: held, and rebuilt.
    logs = [];
    const r2 = open();
    expect(r2.source).toBe('file');
    expect(r2.hold?.unnamed).toEqual(['lib-0a0a0a', 'lib-0b0b0b', 'lib-0c0c0c']);
    expect(r2.state.libraries.map((l) => l.id)).toEqual(['all-files', 'lib-0a0a0a', 'lib-0b0b0b', 'lib-0c0c0c']);
    // All files' record as shell.json had it: from a trusted file, a named record is never changed.
    expect(r2.state.libraries[0]!.folders).toEqual([]);
    expect(await check(r2)).toBe('skipped');
    expect(
      logs.some((l) => l.includes('library folders shell.json did not name: lib-0a0a0a, lib-0b0b0b, lib-0c0c0c')),
    ).toBe(true);
    expect(libraryData()).toEqual(before);

    // Start 3: start 2 saved them, so now everything is named: the hold lifts, nothing is removed.
    logs = [];
    const r3 = open();
    expect(r3.hold?.unnamed).toEqual([]);
    expect(await check(r3)).toBe('done');
    expect(libraryData()).toEqual(before);
  });

  it('the hold lifts after the user deletes the leftover libraries in the app', async () => {
    makeData();
    put(file(), 'junk');
    const r1 = open();
    expect(await check(r1)).toBe('skipped');
    // A delete removes the library's folders and then its record (library-data.ts removeLibraryData).
    for (const id of ['lib-0a0a0a', 'lib-0c0c0c']) {
      fs.rmSync(libDir(id), { recursive: true, force: true });
      fs.rmSync(path.join(storageDir, 'documents', 'askfiles', id), { recursive: true, force: true });
    }
    saveShellState(dataDir, {
      ...r1.state,
      libraries: r1.state.libraries.filter((l) => !['lib-0a0a0a', 'lib-0c0c0c'].includes(l.id)),
    });
    logs = [];
    const r2 = open();
    expect(await check(r2)).toBe('done');
    expect(readSelfCheckHold(dataDir)).toBeNull();
  });
});

describe('other starts', () => {
  it('a first install sets no hold and rebuilds nothing', () => {
    const r = open();
    expect(r.source).toBe('missing');
    expect(r.restored).toBe(false);
    expect(r.hold).toBeNull();
    expect(fs.existsSync(path.join(dataDir, SELF_CHECK_HOLD))).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('a normal start changes nothing and sets no hold', () => {
    makeData();
    const s = emptyShellState();
    s.apiKey = 'INVENTED-KEY';
    s.setupCompletedAt = '2026-11-01T09:00:00.000Z';
    s.libraries[0]!.workspaceSlug = 'askfiles-library';
    saveShellState(dataDir, s);
    const r = open();
    expect(r.source).toBe('file');
    expect(r.hold).toBeNull();
    expect(r.restored).toBe(false);
    expect(r.state.libraries).toHaveLength(1);
  });

  it('from the backup, adds the libraries and sources the last save had and the backup lacks', () => {
    makeData();
    const s = emptyShellState();
    s.apiKey = 'INVENTED-KEY';
    s.setupCompletedAt = '2026-11-01T09:00:00.000Z';
    s.libraries[0]!.workspaceSlug = 'askfiles-library';
    // One save behind: no folder in All files yet, and only lib-0b0b0b, under its old name.
    s.libraries.push({
      id: 'lib-0b0b0b',
      name: 'Old Name',
      workspaceSlug: 'askfiles-lib-0b0b0b',
      folders: [],
      createdAt: '2026-11-04T07:00:00.000Z',
    });
    put(backup(), JSON.stringify(s));
    const r = open();
    expect(r.source).toBe('backup');
    expect(r.restored).toBe(true);
    expect(r.state.apiKey).toBe('INVENTED-KEY');
    expect(r.state.libraries[0]!.folders.map((f) => f.path)).toEqual([HANDBOOK]);
    // library.json is newer than the backup.
    expect(r.state.libraries.find((l) => l.id === 'lib-0b0b0b')!.name).toBe('Invented Projects');
    expect(r.state.libraries.map((l) => l.id)).toEqual(['all-files', 'lib-0b0b0b', 'lib-0a0a0a', 'lib-0c0c0c']);
    expect(r.hold?.reason).toBe('shell.json replaced by its backup');
  });

  it('logs a folder source whose path cannot be worked out, and rebuilds the rest', () => {
    put(
      path.join(libDir('all-files'), 'index.json'),
      index([
        record(`${HANDBOOK}/guide.md`, 'Invented Handbook/guide.md', 'folder-1'),
        record('/Users/tester/odd.md', 'odd.md', 'folder-2'),
      ]),
    );
    put(file(), 'junk');
    const r = open();
    expect(r.state.libraries[0]!.folders.map((f) => f.id)).toEqual(['folder-1']);
    expect(logs).toContain(
      '[recovery] all-files: source folder-2 not rebuilt: its folder cannot be worked out from its 1 files',
    );
  });

  it('gives a rebuilt library a free name when its own is taken', () => {
    makeData();
    const s = emptyShellState();
    s.libraries.push({
      id: 'lib-0d0d0d',
      name: 'invented projects',
      workspaceSlug: null,
      folders: [],
      createdAt: '2026-11-05T00:00:00.000Z',
    });
    put(backup(), JSON.stringify(s));
    const r = open();
    expect(r.state.libraries.find((l) => l.id === 'lib-0b0b0b')!.name).toBe('Recovered library 2');
  });
});

describe('shell.json backup and library copies', () => {
  function complete(name: string): ShellState {
    const s = emptyShellState();
    s.apiKey = 'INVENTED-KEY';
    s.setupCompletedAt = '2026-11-01T09:00:00.000Z';
    s.libraries[0]!.workspaceSlug = 'askfiles-library';
    s.libraries.push({
      id: 'lib-0a0a0a',
      name,
      workspaceSlug: 'askfiles-lib-0a0a0a',
      folders: [],
      createdAt: '2026-11-02T09:00:00.000Z',
    });
    return s;
  }

  it('keeps a backup from the first start that reads shell.json, before any save', () => {
    saveShellState(dataDir, complete('First'));
    expect(fs.existsSync(backup())).toBe(false);
    const r = readShellState(dataDir);
    expect(r.source).toBe('file');
    expect(fs.readFileSync(backup(), 'utf8')).toBe(fs.readFileSync(file(), 'utf8'));
    expect(fs.statSync(backup()).mode & 0o777).toBe(0o600);
    // So a damaged file right after an update still finds it.
    fs.appendFileSync(file(), 'junk');
    expect(readShellState(dataDir).state.libraries[1]!.name).toBe('First');
  });

  it('never replaces a backup that reads while the self-check is held', () => {
    saveShellState(dataDir, complete('Good'));
    readShellState(dataDir);
    const good = fs.readFileSync(backup(), 'utf8');
    put(path.join(dataDir, SELF_CHECK_HOLD), '{"since":"2026-11-16T07:00:00.000Z","reason":"invented"}');
    saveShellState(dataDir, complete('Rebuilt'));
    saveShellState(dataDir, complete('Rebuilt again'));
    readShellState(dataDir);
    expect(fs.readFileSync(backup(), 'utf8')).toBe(good);
    clearSelfCheckHold(dataDir);
    saveShellState(dataDir, complete('After'));
    expect(JSON.parse(fs.readFileSync(backup(), 'utf8')).libraries[1].name).toBe('Rebuilt again');
  });

  it('writes each library record into its own folder when that folder exists, never for a library being deleted', () => {
    fs.mkdirSync(libDir('all-files'), { recursive: true });
    fs.mkdirSync(libDir('lib-0a0a0a'), { recursive: true });
    const s = complete('Invented Board');
    s.libraries.push({
      id: 'lib-0e0e0e',
      name: 'No folder',
      workspaceSlug: null,
      folders: [],
      createdAt: '2026-11-02T09:00:00.000Z',
    });
    saveShellState(dataDir, s);
    expect(JSON.parse(fs.readFileSync(path.join(libDir('lib-0a0a0a'), LIBRARY_RECORD_FILE), 'utf8')).name).toBe(
      'Invented Board',
    );
    expect(fs.existsSync(path.join(libDir('all-files'), LIBRARY_RECORD_FILE))).toBe(true);
    expect(fs.existsSync(libDir('lib-0e0e0e'))).toBe(false);
    s.libraries[1] = { ...s.libraries[1]!, name: 'Renamed', deleting: true };
    saveShellState(dataDir, s);
    expect(JSON.parse(fs.readFileSync(path.join(libDir('lib-0a0a0a'), LIBRARY_RECORD_FILE), 'utf8')).name).toBe(
      'Invented Board',
    );
  });
});

describe('finishing a restored setup without the first run', () => {
  const restoredState = (): ShellState => {
    const s = emptyShellState();
    s.libraries.push({
      id: 'lib-0a0a0a',
      name: 'Recovered library 1',
      workspaceSlug: null,
      folders: [],
      createdAt: '2026-11-02T09:00:00.000Z',
    });
    s.libraries.push({
      id: 'lib-0b0b0b',
      name: 'Invented Projects',
      workspaceSlug: null,
      folders: [],
      createdAt: '2026-11-02T09:00:00.000Z',
    });
    return s;
  };

  it('is chosen only for restored libraries when the server settings exist', () => {
    const s = restoredState();
    expect(shouldFinishRestore(s, true, true)).toBe(true);
    expect(shouldFinishRestore(s, true, false)).toBe(false);
    expect(shouldFinishRestore(s, false, true)).toBe(false);
    const done = {
      ...s,
      apiKey: 'K',
      setupCompletedAt: 'T',
      libraries: s.libraries.map((l) => ({ ...l, workspaceSlug: `askfiles-${l.id}` })),
    };
    expect(shouldFinishRestore(done, true, true)).toBe(false);
  });

  it('makes the key and the workspaces, and keeps going when one library has none', async () => {
    const asked: string[] = [];
    const next = await finishRestore({
      state: restoredState(),
      ensureApiKey: async (stored) => {
        expect(stored).toBeNull();
        return { apiKey: 'INVENTED-NEW-KEY', created: true };
      },
      ensureDefault: async () => 'askfiles-library',
      ensureWorkspace: async (_key, id) => {
        asked.push(id);
        if (id === 'lib-0b0b0b') throw new Error('invented failure');
        return `askfiles-${id}`;
      },
      log,
      now: () => new Date('2026-11-16T07:00:00.000Z'),
    });
    expect(asked).toEqual(['lib-0a0a0a', 'lib-0b0b0b']);
    expect(next.apiKey).toBe('INVENTED-NEW-KEY');
    expect(next.setupCompletedAt).toBe('2026-11-16T07:00:00.000Z');
    expect(next.libraries.map((l) => l.workspaceSlug)).toEqual(['askfiles-library', 'askfiles-lib-0a0a0a', null]);
    expect(logs.some((l) => l.includes('lib-0b0b0b: workspace not found or made (invented failure)'))).toBe(true);
  });

  it('throws when the default library gets no workspace, so the first run starts instead', async () => {
    await expect(
      finishRestore({
        state: restoredState(),
        ensureApiKey: async () => ({ apiKey: 'K', created: false }),
        ensureDefault: async () => {
          throw new Error('invented: server down');
        },
        ensureWorkspace: async () => 'x',
        log,
      }),
    ).rejects.toThrow('invented: server down');
  });
});
