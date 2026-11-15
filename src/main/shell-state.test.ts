import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowseIndex, chunkReader, followWatcher } from './browse/index.js';
import { LibraryManager } from './libraries.js';
import { startupLibraryCheck, vectorCacheName } from './library-data.js';
import {
  emptyShellState,
  readShellState,
  saveShellState,
  SHELL_STATE_BACKUP,
  SHELL_STATE_FILE,
  type ShellState,
} from './shell-state.js';
import { countingSplitter, fakeApi, manualWatch } from './watcher/__fixtures__/fakes.js';
import { FolderWatcher } from './watcher/index.js';

let tmp: string;
let dataDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-shell-')));
  dataDir = path.join(tmp, 'AskFiles');
  fs.mkdirSync(dataDir, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const file = () => path.join(dataDir, SHELL_STATE_FILE);
const backup = () => path.join(dataDir, SHELL_STATE_BACKUP);

function state(name: string): ShellState {
  const s = emptyShellState();
  s.apiKey = 'invented-key';
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

describe('shell.json writes', () => {
  it('goes through a temporary file and keeps the previous version as the backup, mode 0600', () => {
    saveShellState(dataDir, state('First'));
    expect(fs.existsSync(backup())).toBe(false);
    const firstText = fs.readFileSync(file(), 'utf8');
    saveShellState(dataDir, state('Second'));
    expect(fs.readFileSync(backup(), 'utf8')).toBe(firstText);
    expect(readShellState(dataDir).state.libraries[1]!.name).toBe('Second');
    expect(fs.statSync(backup()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    // No temporary file is left behind.
    expect(fs.readdirSync(dataDir).sort()).toEqual([SHELL_STATE_FILE, SHELL_STATE_BACKUP].sort());
  });

  it('never replaces a good backup with a damaged file', () => {
    saveShellState(dataDir, state('First'));
    saveShellState(dataDir, state('Second'));
    const good = fs.readFileSync(backup(), 'utf8');
    fs.writeFileSync(file(), '{"version": 2, "libraries": [');
    saveShellState(dataDir, state('Third'));
    expect(fs.readFileSync(backup(), 'utf8')).toBe(good);
  });
});

describe('shell.json reads', () => {
  it('loads the backup when shell.json is corrupt, logs it and moves the damaged file aside', () => {
    saveShellState(dataDir, state('First'));
    saveShellState(dataDir, state('Second'));
    fs.writeFileSync(file(), '{"version": 2, "libra');
    const logs: string[] = [];
    const r = readShellState(dataDir, (m) => logs.push(m));
    expect(r.source).toBe('backup');
    expect(r.state.libraries.map((l) => l.name)).toEqual(['All files', 'First']);
    expect(r.state.apiKey).toBe('invented-key');
    expect(logs.some((l) => l.includes('loaded the backup'))).toBe(true);
    const aside = fs.readdirSync(dataDir).filter((n) => n.startsWith(`${SHELL_STATE_FILE}.broken-`));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir, aside[0]!), 'utf8')).toBe('{"version": 2, "libra');
  });

  it('loads the backup when shell.json is missing, and is empty only without either', () => {
    expect(readShellState(dataDir).source).toBe('missing');
    saveShellState(dataDir, state('First'));
    saveShellState(dataDir, state('Second'));
    fs.rmSync(file());
    const r = readShellState(dataDir);
    expect(r.source).toBe('backup');
    expect(r.state.libraries[1]!.name).toBe('First');
    fs.writeFileSync(file(), 'not json');
    fs.writeFileSync(backup(), 'not json either');
    const e = readShellState(dataDir);
    expect(e.source).toBe('unreadable');
    expect(e.state).toEqual(emptyShellState());
  });

  it('names every library id of the file, also of a record too damaged to load', () => {
    const s = state('First') as unknown as { libraries: unknown[] };
    s.libraries.push({ id: 'lib-0b0b0b', name: '' });
    fs.writeFileSync(file(), JSON.stringify(s));
    const r = readShellState(dataDir);
    expect(r.state.libraries.map((l) => l.id)).toEqual(['all-files', 'lib-0a0a0a']);
    expect([...r.knownIds].sort()).toEqual(['all-files', 'lib-0a0a0a', 'lib-0b0b0b']);
  });

  it('keeps the deleting mark and never shows a library being deleted', () => {
    const s = state('Old');
    s.libraries[1]!.deleting = true;
    s.currentLibrary = 'lib-0a0a0a';
    saveShellState(dataDir, s);
    const r = readShellState(dataDir).state;
    expect(r.libraries[1]).toMatchObject({ id: 'lib-0a0a0a', deleting: true });
    expect(r.currentLibrary).toBe('all-files');
  });

  it('runs no self-check on a backup or an empty state', async () => {
    // An invented library folder shell.json's backup does not name: from the backup it must stay.
    fs.mkdirSync(path.join(dataDir, 'libraries', 'lib-0c0c0c'), { recursive: true });
    saveShellState(dataDir, state('First'));
    saveShellState(dataDir, state('Second'));
    fs.writeFileSync(file(), 'not json');
    const r = readShellState(dataDir);
    const logs: string[] = [];
    const outcome = await startupLibraryCheck({
      source: r.source,
      resumeRemovals: async () => [],
      dataDir,
      storageDir: path.join(dataDir, 'storage'),
      state: r.state,
      knownIds: r.knownIds,
      listWorkspaces: async () => [],
      removeWorkspace: async () => {},
      log: (m) => logs.push(m),
    });
    expect(outcome).toBe('skipped');
    expect(fs.existsSync(path.join(dataDir, 'libraries', 'lib-0c0c0c'))).toBe(true);
    expect(logs.some((l) => l.includes('[self-check] skipped'))).toBe(true);
  });
});

/**
 * A tester's data folder as the app before this change left it (everything invented): shell.json
 * version 2 written by that version, two libraries with every kind of source, their records,
 * section documents, vector tables, vector and OCR cache entries, and the models.
 */
describe('a data folder in the current layout', () => {
  const LIB = 'lib-4e5f6a';
  const docpaths = [
    'askfiles/all-files/folder-1-guide-1a2b3c-1-0.json',
    `askfiles/${LIB}/file-1-minutes-4d5e6f-1-0.json`,
  ];
  const hashes = ['1'.repeat(64), '2'.repeat(64)];

  const shellJson = {
    version: 2,
    apiKey: 'INVENTED-KEY-0000',
    setupCompletedAt: '2026-11-03T08:00:00.000Z',
    libraries: [
      {
        id: 'all-files',
        name: 'All files',
        workspaceSlug: 'askfiles-library',
        folders: [{ id: 'folder-1', path: '/Users/tester/Invented Handbook', addedAt: '2026-11-03T08:05:00.000Z' }],
        createdAt: '1970-01-01T00:00:00.000Z',
        sectionSummaries: true,
      },
      {
        id: LIB,
        name: 'Invented Board',
        workspaceSlug: `askfiles-${LIB}`,
        folders: [],
        files: [{ id: 'file-1', path: '/Users/tester/Desktop/minutes.docx', addedAt: '2026-11-04T10:00:00.000Z' }],
        lastFileId: 1,
        createdAt: '2026-11-04T09:59:00.000Z',
        profile: 'team-work',
        typeOverrides: { 'team-work': { '0123456789abcdef': 'record' } },
        familyDecisions: { '0123456789abcdef|fedcba9876543210': true },
      },
    ],
    currentLibrary: LIB,
    settings: { answerScope: 'strict', answerModel: 'faster', contextLength: 16384 },
  };

  function put(p: string, text = '{}'): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }

  function makeFolder(): string {
    const storage = path.join(dataDir, 'storage');
    put(file(), JSON.stringify(shellJson, null, 2) + '\n');
    for (const [i, id] of ['all-files', LIB].entries()) {
      const location = docpaths[i]!;
      const index = {
        version: 1,
        files: {
          [`/Users/tester/invented-${i}.pdf`]: {
            path: `/Users/tester/invented-${i}.pdf`,
            hash: hashes[i],
            sections: [{ location }],
          },
        },
      };
      put(path.join(dataDir, 'libraries', id, 'index.json'), JSON.stringify(index));
      put(path.join(dataDir, 'libraries', id, 'browse', 'doc.json'));
      put(path.join(dataDir, 'libraries', id, 'summaries', 'doc.json'));
      put(path.join(dataDir, 'libraries', id, 'graph.json'));
      put(path.join(storage, 'documents', location), JSON.stringify({ pageContent: 'Invented.' }));
      put(path.join(storage, 'vector-cache', vectorCacheName(location)), '[]');
      put(path.join(dataDir, 'ocr-cache', `${hashes[i]}.pages.json`));
    }
    put(path.join(dataDir, 'libraries', LIB, 'files', 'old-copy.md'), '# Copy made by an earlier version');
    put(path.join(storage, 'lancedb', 'askfiles-library.lance', 'data'));
    put(path.join(storage, 'lancedb', `askfiles-${LIB}.lance`, 'data'));
    put(path.join(storage, 'askfiles.db'), 'db');
    put(path.join(dataDir, 'ollama', 'models', 'manifests', 'invented'), 'manifest');
    put(path.join(dataDir, 'server', '.env'), 'INVENTED=1');
    return storage;
  }

  function snapshot(): string[] {
    const out: string[] = [];
    const visit = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) visit(p);
        else out.push(`${path.relative(dataDir, p)} ${fs.readFileSync(p, 'utf8').length}`);
      }
    };
    visit(dataDir);
    return out.sort();
  }

  it('loads unchanged, keeps every file through the self-check, and saves the same records', async () => {
    const storage = makeFolder();
    const before = snapshot();
    const r = readShellState(dataDir);
    expect(r.source).toBe('file');
    // Every field as written, nothing added (no deleting mark), the current library kept.
    expect(JSON.parse(JSON.stringify(r.state))).toEqual(shellJson);

    const logs: string[] = [];
    const outcome = await startupLibraryCheck({
      source: r.source,
      resumeRemovals: async () => [],
      dataDir,
      storageDir: storage,
      state: r.state,
      knownIds: r.knownIds,
      listWorkspaces: async () => [
        { name: 'askfiles-library', slug: 'askfiles-library' },
        { name: `askfiles-${LIB}`, slug: `askfiles-${LIB}` },
      ],
      removeWorkspace: async (slug) => {
        throw new Error(`no workspace may go, asked for ${slug}`);
      },
      log: (m) => logs.push(m),
    });
    expect(outcome).toBe('done');
    expect(logs).toContain('[self-check] nothing to remove');
    expect(snapshot()).toEqual(before);

    // The libraries show as before, sources included.
    let s = r.state;
    const manager = new LibraryManager({
      dataDir,
      storageDir: storage,
      ocrCacheDir: path.join(dataDir, 'ocr-cache'),
      getState: () => s,
      setState: (n) => (s = n),
      workspaces: { ensure: async () => '', remove: async () => {} },
      removeDocuments: () => {},
      createWatcher: (o) =>
        new FolderWatcher({
          ...o,
          storageDir: storage,
          api: fakeApi(storage),
          splitter: countingSplitter(),
          watch: manualWatch(),
        }),
      createBrowse: (o) => new BrowseIndex({ dir: o.dir, readChunk: chunkReader(storage), log: () => {} }),
      followWatcher: (b, w) => followWatcher(b, w),
      onChange: () => {},
      onStatus: () => {},
    });
    const v = manager.view();
    expect(v.current).toBe(LIB);
    expect(v.libraries.map((l) => [l.name, l.indexed, l.profile, l.sources.map((x) => x.kind)])).toEqual([
      ['All files', 1, 'legal-finance', ['folder']],
      ['Invented Board', 1, 'team-work', ['file', 'copy']],
    ]);

    // The first save after the update writes the same records and keeps the old file as the backup.
    const original = fs.readFileSync(file(), 'utf8');
    saveShellState(dataDir, r.state);
    expect(fs.readFileSync(backup(), 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual(shellJson);
  });
});
