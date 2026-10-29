import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeApi, headingSplitter, manualWatch, oneSectionSplitter, type FakeApi } from './__fixtures__/fakes.js';
import { chokidarWatch } from './fs-watch.js';
import type { FileEvent, IndexData, Splitter, WatchFactory } from './types.js';
import { FolderWatcher } from './watcher.js';

let tmp: string;
let root: string;
let dataDir: string;
let storageDir: string;
let api: FakeApi;
const running: FolderWatcher[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-watcher-')));
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

function make(opts: { watch?: WatchFactory; splitter?: Splitter; retryDelaysMs?: number[]; debounceMs?: number } = {}) {
  const events: FileEvent[] = [];
  const w = new FolderWatcher({
    root,
    dataDir,
    storageDir,
    workspaceSlug: 'library',
    api,
    splitter: opts.splitter ?? oneSectionSplitter(),
    watch: opts.watch ?? manualWatch(),
    debounceMs: opts.debounceMs ?? 30,
    stableMs: 30,
    retryDelaysMs: opts.retryDelaysMs ?? [10, 20, 40],
    log: () => {},
  });
  w.on('file', (e) => events.push(e));
  running.push(w);
  return { w, events };
}

const readIndex = (): IndexData => {
  const file = path.join(dataDir, 'index.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, files: {} };
};
const write = (name: string, text: string) => {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const readDoc = (location: string) =>
  JSON.parse(fs.readFileSync(path.join(storageDir, 'documents', location), 'utf8')) as Record<string, unknown>;

describe('FolderWatcher', () => {
  it('indexes an added file: section document, embedding and index.json record', async () => {
    const watch = manualWatch();
    const { w, events } = make({ watch });
    await w.start();
    const p = write('notes/leave.md', 'Annual leave is 27 days.');
    watch.emit('add', p);
    await w.whenIdle();

    const rec = readIndex().files[p]!;
    expect(rec.path).toBe(p);
    expect(rec.url).toBe(`file://${p}`);
    expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.sections).toHaveLength(1);
    const sec = rec.sections[0]!;
    expect(sec.location).toMatch(/^askfiles\/[0-9a-f]{16}-[0-9a-f]{16}\.json$/);
    expect(sec.docId).toBe(api.embedded.get(sec.location));
    expect(Date.parse(rec.indexedAt)).not.toBeNaN();

    const doc = readDoc(sec.location);
    expect(doc).toMatchObject({
      title: 'leave.md',
      url: `file://${p}`,
      pageContent: 'Annual leave is 27 days.',
      sectionTitle: 'leave.md',
      sectionIndex: 1,
      pageStart: 0,
      pageEnd: 0,
      sourcePath: p,
      docSource: 'askfiles section split',
    });
    expect(events).toEqual([{ path: p, kind: 'upsert', outcome: 'indexed', sections: 1 }]);
    expect(w.status()).toMatchObject({ state: 'idle', pending: 0, indexed: 1, deadLetters: [] });
  });

  it('re-embeds only changed sections and removes the stale ones', async () => {
    const watch = manualWatch();
    const { w } = make({ watch, splitter: headingSplitter() });
    await w.start();
    const p = write('h.md', '# One\nfirst body\n# Two\nsecond body\n');
    watch.emit('add', p);
    await w.whenIdle();
    const before = readIndex().files[p]!.sections.map((s) => s.location);
    expect(before).toHaveLength(2);

    write('h.md', '# One\nfirst body\n# Two\nsecond body, edited\n');
    api.log.length = 0;
    watch.emit('change', p);
    await w.whenIdle();
    const after = readIndex().files[p]!.sections.map((s) => s.location);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(api.log).toEqual(['embed +1 -0', 'remove 1']);
    expect([...api.embedded.keys()].sort()).toEqual([...after].sort());
    expect(fs.existsSync(path.join(storageDir, 'documents', before[1]!))).toBe(false);
  });

  it('does nothing when a change event leaves the content as it was', async () => {
    const watch = manualWatch();
    const splitter = oneSectionSplitter();
    const { w, events } = make({ watch, splitter });
    await w.start();
    const p = write('a.txt', 'same');
    watch.emit('add', p);
    await w.whenIdle();
    api.log.length = 0;
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5000));
    watch.emit('change', p);
    await w.whenIdle();
    expect(api.log).toEqual([]);
    expect(splitter.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ outcome: 'unchanged' });
    expect(readIndex().files[p]!.mtimeMs).toBe(fs.statSync(p).mtimeMs);
  });

  it('removes a deleted file from the workspace and from index.json', async () => {
    const watch = manualWatch();
    const { w, events } = make({ watch });
    await w.start();
    const p = write('gone.md', 'text');
    watch.emit('add', p);
    await w.whenIdle();
    const location = readIndex().files[p]!.sections[0]!.location;

    fs.rmSync(p);
    watch.emit('unlink', p);
    await w.whenIdle();
    expect(readIndex().files[p]).toBeUndefined();
    expect(api.embedded.has(location)).toBe(false);
    expect(events.at(-1)).toEqual({ path: p, kind: 'remove', outcome: 'removed', sections: 1 });
  });

  it('treats unlink followed by add (an editor saving by rename) as one unchanged file', async () => {
    const watch = manualWatch();
    const { w } = make({ watch });
    await w.start();
    const p = write('saved.md', 'v1');
    watch.emit('add', p);
    await w.whenIdle();
    api.log.length = 0;
    fs.rmSync(p);
    watch.emit('unlink', p);
    write('saved.md', 'v1');
    watch.emit('add', p);
    await w.whenIdle();
    expect(api.log).toEqual([]);
    expect(readIndex().files[p]).toBeDefined();
  });

  it('waits while a file is still growing (partial write)', async () => {
    const watch = manualWatch();
    const splitter = oneSectionSplitter();
    const { w } = make({ watch, splitter, debounceMs: 60 });
    await w.start();
    const p = write('big.txt', 'part one');
    const t0 = Date.now();
    watch.emit('add', p);
    // The writer goes on without a new event reaching the watcher; only the size check sees it.
    fs.appendFileSync(p, ' and part two');
    let embeddedAt = 0;
    const orig = api.updateEmbeddings;
    api.updateEmbeddings = async (...args) => {
      embeddedAt = Date.now();
      return orig(...args);
    };
    await w.whenIdle();
    expect(splitter.calls).toEqual([p]);
    expect(readDoc(readIndex().files[p]!.sections[0]!.location).pageContent).toBe('part one and part two');
    // Debounce, then one more stable period because the size had changed.
    expect(embeddedAt - t0).toBeGreaterThanOrEqual(60 + 30);
  });

  it('reconciles the folder against index.json after a restart', async () => {
    const splitter = oneSectionSplitter();
    const first = make({ splitter });
    const keep = write('keep.md', 'unchanged');
    const edit = write('edit.md', 'old text');
    const gone = write('gone.md', 'will be deleted');
    await first.w.start();
    await first.w.whenIdle();
    expect(Object.keys(readIndex().files).sort()).toEqual([edit, gone, keep].sort());
    await first.w.stop();

    // While the shell is not running.
    fs.writeFileSync(edit, 'new text, longer');
    fs.rmSync(gone);
    const added = write('sub/new.md', 'brand new');
    splitter.calls.length = 0;

    const second = make({ splitter });
    await second.w.start();
    await second.w.whenIdle();
    const files = readIndex().files;
    expect(Object.keys(files).sort()).toEqual([added, edit, keep].sort());
    expect(splitter.calls.sort()).toEqual([added, edit].sort());
    expect(readDoc(files[edit]!.sections[0]!.location).pageContent).toBe('new text, longer');
    expect(api.embedded.size).toBe(3);
    expect(second.events.map((e) => `${e.outcome} ${path.basename(e.path)}`).sort()).toEqual([
      'indexed edit.md',
      'indexed new.md',
      'removed gone.md',
    ]);
  });

  it('retries a failed upload and then succeeds', async () => {
    const watch = manualWatch();
    const { w, events } = make({ watch });
    await w.start();
    api.failNext = 2;
    const p = write('flaky.md', 'text');
    watch.emit('add', p);
    await w.whenIdle();
    expect(events.map((e) => e.outcome)).toEqual(['retrying', 'retrying', 'indexed']);
    expect(events[0]).toMatchObject({ attempt: 1, error: expect.stringContaining('500') });
    expect(api.embedded.size).toBe(1);
    expect(w.status().deadLetters).toEqual([]);
  });

  it('moves a job to the dead-letter list after three retries and keeps the others going', async () => {
    const watch = manualWatch();
    const { w, events } = make({ watch });
    const statuses: number[] = [];
    w.on('status', (s) => statuses.push(s.deadLetters.length));
    await w.start();
    api.dropAdds = true;
    const bad = write('bad.md', 'never embeds');
    watch.emit('add', bad);
    await w.whenIdle();
    expect(events.map((e) => e.outcome)).toEqual(['retrying', 'retrying', 'retrying', 'dead-letter']);
    const dl = w.status().deadLetters;
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({
      path: bad,
      kind: 'upsert',
      attempts: 4,
      error: 'server did not embed 1 of 1 sections',
    });
    expect(statuses.at(-1)).toBe(1);
    expect(readIndex().files[bad]).toBeUndefined();

    // A later event for the same file takes it off the list and tries again.
    api.dropAdds = false;
    watch.emit('change', bad);
    await w.whenIdle();
    expect(w.status().deadLetters).toEqual([]);
    expect(readIndex().files[bad]).toBeDefined();
  });

  it('ignores hidden, lock and unsupported files', async () => {
    const watch = manualWatch();
    const { w, events } = make({ watch });
    write('.hidden/a.md', 'x');
    write('~$report.docx', 'x');
    write('song.mp3', 'x');
    write('.DS_Store', 'x');
    await w.start();
    for (const n of ['.hidden/a.md', '~$report.docx', 'song.mp3', '.DS_Store']) watch.emit('add', path.join(root, n));
    await w.whenIdle();
    expect(events).toEqual([]);
    expect(api.log).toEqual([]);
  });

  it('fills section titles into vector-search results from its own records', async () => {
    const watch = manualWatch();
    const { w } = make({ watch, splitter: headingSplitter() });
    await w.start();
    const p = write('h.md', '# One\nalpha beta gamma\n# Two\ndelta epsilon\n');
    watch.emit('add', p);
    await w.whenIdle();
    const [hit] = w.resolveSources([{ title: 'h.md', url: `file://${p}`, text: 'delta  epsilon' }]);
    expect(hit).toMatchObject({ sectionTitle: 'Two', sectionIndex: 2, page: 2, pageEnd: 2 });
  });

  it('works with the real chokidar watch', async () => {
    const { w } = make({ watch: chokidarWatch });
    await w.start();
    const p = write('live.md', 'seen by chokidar');
    const deadline = Date.now() + 10_000;
    while (!readIndex().files[p]) {
      if (Date.now() > deadline) throw new Error('chokidar did not report the new file within 10 s');
      await new Promise((r) => setTimeout(r, 50));
    }
    fs.rmSync(p);
    while (readIndex().files[p]) {
      if (Date.now() > deadline) throw new Error('chokidar did not report the deletion within 10 s');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(api.embedded.size).toBe(0);
  });
});
