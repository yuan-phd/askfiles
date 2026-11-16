// The file types, skipped folders and folder limit in the watcher (owner decision 2026-11-16),
// with invented folders only: what indexed before the rules causes no work, a library over the
// limit at start, and the limit holding while folders are added under a running watch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countingSplitter, fakeApi, manualWatch, type FakeApi } from './__fixtures__/fakes.js';
import { WatchBudget } from './folder-limit.js';
import { createChokidarWatch } from './fs-watch.js';
import type { FileRecord, IndexData, WatchFactory, WatcherStatus } from './types.js';
import { FolderWatcher } from './watcher.js';

let tmp: string;
let root: string;
let dataDir: string;
let storageDir: string;
let api: FakeApi;
const running: FolderWatcher[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-limits-')));
  root = path.join(tmp, 'Documents');
  dataDir = path.join(tmp, 'data');
  storageDir = path.join(dataDir, 'storage');
  fs.mkdirSync(root);
  api = fakeApi(storageDir);
});

afterEach(async () => {
  for (const w of running.splice(0)) await w.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function make(watch: WatchFactory, dir = root) {
  const logs: string[] = [];
  const statuses: WatcherStatus[] = [];
  const splitter = countingSplitter();
  const w = new FolderWatcher({
    roots: [{ id: 'folder-1', path: dir, label: path.basename(dir) }],
    dataDir,
    storageDir,
    workspaceSlug: 'library',
    api,
    splitter,
    watch,
    debounceMs: 30,
    stableMs: 30,
    retryDelaysMs: [10],
    availabilityPollMs: 0,
    log: (m) => logs.push(m),
  });
  w.on('status', (s) => statuses.push(s));
  running.push(w);
  return { w, logs, statuses, splitter };
}

function write(rel: string, text = `# Invented\n\nText of ${rel}.`): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

const indexFile = () => path.join(dataDir, 'index.json');
const readIndex = (): IndexData => JSON.parse(fs.readFileSync(indexFile(), 'utf8'));

// Live events come through the system's FSEvents service, which other test files load too.
async function until(check: () => boolean, what: string, ms = 25_000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A record as an earlier version wrote it, with one embedded section. */
function oldRecord(p: string, n: number): FileRecord {
  const location = `askfiles/old-${n}.json`;
  api.embedded.set(location, `doc-${n}`);
  const st = fs.statSync(p);
  return {
    path: p,
    url: `file://${p}`,
    relPath: path.join('Documents', path.relative(root, p)),
    sourceId: 'folder-1',
    hash: 'old',
    splitKey: 'old',
    size: st.size,
    mtimeMs: st.mtimeMs,
    indexedAt: '2026-11-01T10:00:00.000Z',
    sections: [
      {
        location,
        docId: `doc-${n}`,
        sectionTitle: 'Old',
        sectionIndex: 1,
        sectionLevel: 1,
        sectionPath: ['Old'],
        subIndex: 1,
        pageStart: null,
        pageEnd: null,
        pageLabelStart: null,
        pageLabelEnd: null,
      },
    ],
  };
}

describe('files indexed before the file types and skipped folders', () => {
  it('stay in the index and cause no work: 0 to remove, never Indexing, at start and at Check for updates', async () => {
    write('plan.md');
    // Index the one file the rules read, as the library had it.
    const first = make(manualWatch());
    await first.w.start();
    await first.w.whenIdle();
    await first.w.stop();
    running.length = 0;

    // Then add what an earlier version had indexed and the rules no longer read.
    const outside = [
      write('figures.csv', 'a,b\n1,2\n'),
      write('repo/node_modules/left-pad/README.md'),
      write('repo/__pycache__/notes.txt'),
      write('repo/.git/description.md'),
      write('Talk.key/preview.pdf', 'not really a pdf'),
      write('Old.app/Contents/Resources/help.md'),
      write('$RECYCLE.BIN/deleted.docx', 'x'),
      write('tools/env/lib/LICENSE.txt'),
    ];
    write('tools/env/pyvenv.cfg', 'home = /usr/bin\n');
    const data = readIndex();
    outside.forEach((p, i) => (data.files[p] = oldRecord(p, i)));
    fs.writeFileSync(indexFile(), JSON.stringify(data));
    const embeddedBefore = api.embedded.size;
    api.log.length = 0;

    const watch = manualWatch();
    const { w, logs, statuses, splitter } = make(watch);
    await w.start();
    await w.whenIdle();
    expect(logs.find((l) => l.startsWith('reconcile:'))).toBe(
      'reconcile: 1 files in folders, 0 to check, 0 to remove, 8 indexed before the file types and skipped folders kept as they are',
    );
    expect(statuses.every((s) => s.state !== 'working' && s.pending === 0)).toBe(true);
    expect(w.status()).toMatchObject({ state: 'idle', pending: 0, indexed: 9, notWatched: 0 });
    expect(Object.keys(readIndex().files).sort()).toEqual([...outside, path.join(root, 'plan.md')].sort());
    expect(api.log).toEqual([]);
    expect(api.embedded.size).toBe(embeddedBefore);
    expect(splitter.calls).toEqual([]);

    // A later walk (Check for updates) and events for those files change nothing either.
    expect(await w.checkNow()).toEqual({ toCheck: 0 });
    fs.writeFileSync(outside[0]!, 'a,b\n3,4\n');
    watch.emit('change', outside[0]!);
    fs.rmSync(outside[1]!);
    watch.emit('unlink', outside[1]!);
    await new Promise((r) => setTimeout(r, 100));
    await w.whenIdle();
    expect(w.status()).toMatchObject({ state: 'idle', pending: 0, indexed: 9 });
    expect(api.log).toEqual([]);
  });

  it('reads no new file inside a skipped folder or of another type', async () => {
    write('keep/plan.md');
    write('keep/table.csv', 'a,b\n');
    write('keep/deck.pptx', 'not a real deck');
    write('repo/node_modules/pkg/README.md');
    write('venv-like/env/notes.md');
    write('venv-like/env/pyvenv.cfg', 'home = /usr/bin\n');
    write('build/report.md');
    const { w, splitter } = make(manualWatch());
    await w.start();
    await w.whenIdle();
    // The invented deck is not a real pptx: it is tried again, and still only those three are read.
    expect([...new Set(splitter.calls.map((p) => path.relative(root, p)))].sort()).toEqual(
      ['build/report.md', 'keep/deck.pptx', 'keep/plan.md'].sort(),
    );
  });
});

describe('the folder limit in the watch', () => {
  /** Folders a, a/0 .. a/n-1 below root, each with one note. */
  function folders(n: number, top = 'area'): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(write(`${top}/f${i}/note.md`));
    return out;
  }

  it('a library over the limit at start keeps its whole index, watches up to the limit and says so', async () => {
    const notes = folders(12);
    const budget = new WatchBudget(5);
    const { w, logs } = make(createChokidarWatch(budget));
    await w.start();
    await w.whenIdle();
    // Read and indexed whole: watching stops at the limit, reading does not.
    expect(Object.keys(readIndex().files).sort()).toEqual(notes.sort());
    expect(budget.size).toBe(5);
    expect(w.status().notWatched).toBeGreaterThan(0);
    expect(logs).toContain('folder limit reached: some folders are not watched; Check for updates finds their changes');

    // New files in all twelve folders: those in unwatched folders are not seen live, and Check
    // for updates finds them.
    const later = notes.map((n) => {
      const p = path.join(path.dirname(n), 'later.md');
      fs.writeFileSync(p, '# Later\n\nAdded while watching.');
      return p;
    });
    await new Promise((r) => setTimeout(r, 1500));
    await w.whenIdle();
    const live = later.filter((p) => readIndex().files[p]).length;
    expect(live).toBeLessThan(later.length);
    await w.checkNow();
    await w.whenIdle();
    expect(later.every((p) => readIndex().files[p])).toBe(true);

    await w.stop();
    expect(budget.size).toBe(0);
  });

  it('never watches more folders than the limit, also for folders made while watching', async () => {
    folders(2);
    const budget = new WatchBudget(5);
    const { w, statuses } = make(createChokidarWatch(budget));
    await w.start();
    // Documents, area, f0, f1.
    expect(budget.size).toBe(4);
    expect(w.status().notWatched).toBe(0);
    // One at a time: folders made together reach chokidar as one event on their parent, whose
    // read it throttles, which would make the test depend on timing.
    // Under load the FSEvents stream may start a moment after chokidar says ready, and a folder
    // made in between is never reported: make it again until the watch is live.
    const first = path.join(root, 'new-0');
    for (let tries = 0; budget.size < 5 && tries < 12; tries++) {
      fs.rmSync(first, { recursive: true, force: true });
      fs.mkdirSync(first);
      await until(() => budget.size === 5, 'the fifth folder watched', 2000).catch(() => undefined);
    }
    expect(budget.size).toBe(5);
    for (let i = 1; i <= 3; i++) {
      fs.mkdirSync(path.join(root, `new-${i}`));
      await until(() => w.status().notWatched === i, `new folder ${i} refused`);
      expect(budget.size).toBe(5);
    }
    expect(statuses.at(-1)!.notWatched).toBe(3);
  });

  it('skipped folders take no place under the limit and are never watched', async () => {
    folders(2);
    write('repo/node_modules/a/b/c/README.md');
    write('repo/.git/objects/aa/x.txt');
    write('repo/__pycache__/m.txt');
    write('Tool.app/Contents/MacOS/x.txt');
    write('py/env/lib/site.txt');
    write('py/env/pyvenv.cfg', 'home = /usr/bin\n');
    const budget = new WatchBudget(7);
    const { w } = make(createChokidarWatch(budget));
    await w.start();
    await w.whenIdle();
    // Documents, area, f0, f1, repo, py: six of seven.
    expect(budget.size).toBe(6);
    expect(w.status().notWatched).toBe(0);
    const inSkipped = write('repo/node_modules/a/new.md');
    const ordinary = write('area/f0/new.md');
    await until(() => !!readIndex().files[ordinary], 'the new file in a watched folder');
    expect(readIndex().files[inSkipped]).toBeUndefined();
  });

  it('is shared by every watch of the process: the next library gets the folders the last one freed', async () => {
    // Documents, area and five folders: seven, one over.
    folders(5);
    const other = path.join(tmp, 'Other');
    for (let i = 0; i < 4; i++) fs.mkdirSync(path.join(other, `g${i}`), { recursive: true });
    const budget = new WatchBudget(6);
    const watch = createChokidarWatch(budget);
    const a = make(watch);
    await a.w.start();
    expect(budget.size).toBe(6);
    expect(a.w.status().notWatched).toBeGreaterThan(0);
    await a.w.stop();
    expect(budget.size).toBe(0);
    const b = make(watch, other);
    await b.w.start();
    expect(budget.size).toBe(5);
    expect(b.w.status().notWatched).toBe(0);
  });
});
