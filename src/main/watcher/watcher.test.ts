import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countingSplitter, fakeApi, manualWatch, type FakeApi } from './__fixtures__/fakes.js';
import { chokidarWatch } from './fs-watch.js';
import type { FileEvent, IndexData, LibraryApi, Splitter, WatchFactory, WatchOptions } from './types.js';
import { FolderWatcher, type WatchRoot } from './watcher.js';

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

function make(
  opts: {
    watch?: WatchFactory;
    splitter?: Splitter;
    retryDelaysMs?: number[];
    debounceMs?: number;
    roots?: WatchRoot[];
    api?: LibraryApi;
  } = {},
) {
  const events: FileEvent[] = [];
  const logs: string[] = [];
  const w = new FolderWatcher({
    ...(opts.roots ? { roots: opts.roots } : { root }),
    dataDir,
    storageDir,
    workspaceSlug: 'library',
    api: opts.api ?? api,
    splitter: opts.splitter ?? countingSplitter(),
    watch: opts.watch ?? manualWatch(),
    debounceMs: opts.debounceMs ?? 30,
    stableMs: 30,
    retryDelaysMs: opts.retryDelaysMs ?? [10, 20, 40],
    log: (m) => logs.push(m),
  });
  w.on('file', (e) => events.push(e));
  running.push(w);
  return { w, events, logs };
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
    const { w, events, logs } = make({ watch });
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
    expect(sec.location).toMatch(/^askfiles\/leave\.md-[0-9a-f]{12}-1-1\.json$/);
    expect(rec.splitKey).toMatch(/^[0-9a-f]{12}$/);
    expect(sec.docId).toBe(api.embedded.get(sec.location));
    expect(Date.parse(rec.indexedAt)).not.toBeNaN();

    const doc = readDoc(sec.location);
    expect(doc).toMatchObject({
      title: 'leave.md',
      url: `file://${p}`,
      pageContent: 'leave\nAnnual leave is 27 days.',
      sectionTitle: 'leave',
      sectionIndex: 1,
      subIndex: 1,
      subCount: 1,
      pageStart: 0,
      pageEnd: 0,
      sourcePath: p,
      fileHash: rec.hash,
      splitKey: rec.splitKey,
      docSource: 'askfiles section split',
    });
    expect(sec).toMatchObject({ sectionTitle: 'leave', sectionIndex: 1, subIndex: 1, pageStart: null, pageEnd: null });
    expect(events).toEqual([
      {
        path: p,
        kind: 'upsert',
        outcome: 'indexed',
        sections: 1,
        times: {
          split: expect.any(Number),
          ocr: 0,
          write: expect.any(Number),
          embed: expect.any(Number),
          total: expect.any(Number),
        },
      },
    ]);
    // One timing line per indexed file, for the indexing-time table (docs/app.md).
    expect(
      logs.some((l) =>
        /^timing leave\.md: split \d+ ms, ocr 0 ms, write \d+ ms, embed \d+ ms, total \d+ ms, 1 sections$/.test(l),
      ),
    ).toBe(true);
    expect(w.status()).toMatchObject({ state: 'idle', pending: 0, indexed: 1, deadLetters: [] });
  });

  it('embeds a changed file afresh and removes its old documents', async () => {
    const watch = manualWatch();
    const { w } = make({ watch, splitter: countingSplitter() });
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
    // Names follow the file's bytes (src/main/sections/documents.ts), so every chunk is new.
    for (const l of after) expect(before).not.toContain(l);
    expect(api.log).toEqual(['embed +2 -0', 'remove 2']);
    expect([...api.embedded.keys()].sort()).toEqual([...after].sort());
    for (const l of before) expect(fs.existsSync(path.join(storageDir, 'documents', l))).toBe(false);
  });

  it('does nothing when a change event leaves the content as it was', async () => {
    const watch = manualWatch();
    const splitter = countingSplitter();
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
    const splitter = countingSplitter();
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
    expect(readDoc(readIndex().files[p]!.sections[0]!.location).pageContent).toBe('big\npart one and part two');
    // Debounce, then one more stable period because the size had changed.
    expect(embeddedAt - t0).toBeGreaterThanOrEqual(60 + 30);
  });

  it('reconciles the folder against index.json after a restart', async () => {
    const splitter = countingSplitter();
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
    expect(readDoc(files[edit]!.sections[0]!.location).pageContent).toBe('edit\nnew text, longer');
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
    // The embed fails, then the removal of its pending sections, then the embed again.
    api.failNext = 3;
    const p = write('flaky.md', 'text');
    watch.emit('add', p);
    await w.whenIdle();
    expect(events.map((e) => e.outcome)).toEqual(['retrying', 'retrying', 'indexed']);
    expect(events[0]).toMatchObject({ attempt: 1, error: expect.stringContaining('500') });
    expect(api.embedded.size).toBe(1);
    expect(w.status().deadLetters).toEqual([]);
    expect(readIndex().pending).toBeUndefined();
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
    const { w } = make({ watch, splitter: countingSplitter() });
    await w.start();
    const p = write('h.md', '# One\nalpha beta gamma\n# Two\ndelta epsilon\n');
    watch.emit('add', p);
    await w.whenIdle();
    const [hit] = w.resolveSources([{ title: 'h.md', url: `file://${p}`, text: 'delta  epsilon' }]);
    expect(hit).toMatchObject({ sectionTitle: 'Two', sectionIndex: 2, page: null, pageEnd: null });
  });

  it('indexes the real split: heading-only sections folded, long sections in sub-chunks', async () => {
    const watch = manualWatch();
    const { w } = make({ watch });
    await w.start();
    const long = Array.from({ length: 20 }, (_, i) => `Rule ${i} of the leave policy applies to every employee.`);
    const p = write('policy.md', `# Handbook\n# 1 Leave\n${long.join('\n\n')}\n# 2 Expenses\nClaims within 30 days.\n`);
    watch.emit('add', p);
    await w.whenIdle();
    const recs = readIndex().files[p]!.sections;
    const docs = recs.map((r) => readDoc(r.location));
    // The empty Handbook heading is folded into the next section, never a document of its own.
    expect(docs.some((d) => String(d.pageContent).trim() === 'Handbook')).toBe(false);
    const leave = recs.filter((r) => r.sectionTitle === '1 Leave');
    expect(leave.length).toBeGreaterThan(1);
    expect(leave.map((r) => r.subIndex)).toEqual(leave.map((_, i) => i + 1));
    for (const d of docs) expect(String(d.pageContent).length).toBeLessThanOrEqual(400);
    expect(recs.at(-1)).toMatchObject({ sectionTitle: '2 Expenses', sectionIndex: 2, subIndex: 1 });
    // Every sub-chunk of the long section resolves back to it.
    for (const d of docs.filter((d) => d.sectionTitle === '1 Leave')) {
      const body = String(d.pageContent).split('\n').slice(2).join(' ');
      const [hit] = w.resolveSources([{ title: 'policy.md', url: `file://${p}`, text: body }]);
      expect(hit).toMatchObject({ sectionTitle: '1 Leave', sectionIndex: 1 });
    }
  });

  it('splits every file again when the split settings change', async () => {
    const watch = manualWatch();
    const first = make({ watch, splitter: countingSplitter(400) });
    const p = write('a.md', '# A\nbody');
    await first.w.start();
    await first.w.whenIdle();
    const before = readIndex().files[p]!;
    await first.w.stop();

    const splitter = countingSplitter(800);
    const second = make({ splitter });
    await second.w.start();
    await second.w.whenIdle();
    const after = readIndex().files[p]!;
    expect(splitter.calls).toEqual([p]);
    expect(after.splitKey).not.toBe(before.splitKey);
    expect(after.sections[0]!.location).not.toBe(before.sections[0]!.location);
    expect(api.embedded.size).toBe(1);
  });

  it('puts a file the splitter cannot parse on the dead-letter list', async () => {
    const watch = manualWatch();
    const { w } = make({ watch });
    await w.start();
    const p = write('broken.docx', 'not a zip file');
    watch.emit('add', p);
    await w.whenIdle();
    expect(w.status().deadLetters).toEqual([expect.objectContaining({ path: p, attempts: 4 })]);
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

  it('removes the sections of an update that failed after embedding, at the next start', async () => {
    // Embeds, then the server goes away before the record is saved; the cleanup fails too.
    let down = false;
    const flaky: LibraryApi = {
      updateEmbeddings: async (slug, change) => {
        await api.updateEmbeddings(slug, change);
        down = true;
      },
      removeDocuments: async (slug, l) => {
        if (down) throw new Error('connect ECONNREFUSED');
        return api.removeDocuments(slug, l);
      },
      workspaceDocuments: async (slug) => {
        if (down) throw new Error('connect ECONNREFUSED');
        return api.workspaceDocuments(slug);
      },
    };
    const watch = manualWatch();
    const first = make({ watch, api: flaky, retryDelaysMs: [] });
    await first.w.start();
    const p = write('half.md', '# Half\n\nEmbedded but never saved.');
    watch.emit('add', p);
    await first.w.whenIdle();
    expect(first.events.map((e) => e.outcome)).toEqual(['dead-letter']);
    expect(api.embedded.size).toBe(1);
    const [left] = [...api.embedded.keys()];
    expect(readIndex().files[p]).toBeUndefined();
    expect(readIndex().pending).toEqual({ [p]: [left] });
    await first.w.stop();

    // Next start, server back: the leftover goes before anything else happens.
    down = false;
    fs.rmSync(p);
    const second = make({ watch: manualWatch(), api: flaky });
    await second.w.start();
    await second.w.whenIdle();
    expect(api.embedded.size).toBe(0);
    expect(fs.existsSync(path.join(storageDir, 'documents', left!))).toBe(false);
    expect(readIndex().pending).toBeUndefined();
    expect(second.logs).toContain(`removed 1 sections left by an unfinished update of ${p}`);
  });

  it('removes the pending sections right after a failure when the server allows it', async () => {
    const watch = manualWatch();
    const { w, events } = make({ watch, retryDelaysMs: [] });
    await w.start();
    // The embed works; the server then says it embedded nothing, so the job fails.
    const real = api.workspaceDocuments.bind(api);
    let reads = 0;
    api.workspaceDocuments = async (slug) => (++reads === 2 ? new Map() : real(slug));
    const p = write('lost.md', '# Lost\n\nText.');
    watch.emit('add', p);
    await w.whenIdle();
    expect(events.map((e) => e.outcome)).toEqual(['dead-letter']);
    expect(api.embedded.size).toBe(0);
    expect(readIndex().pending).toBeUndefined();
  });

  it('keeps an unchanged section of a changed file when it cleans up', async () => {
    const watch = manualWatch();
    const { w } = make({ watch });
    await w.start();
    const p = write('two.md', '# One\n\nFirst part.\n\n# Two\n\nSecond part.');
    watch.emit('add', p);
    await w.whenIdle();
    const before = readIndex().files[p]!.sections.map((s) => s.location);
    write('two.md', '# One\n\nFirst part.\n\n# Two\n\nSecond part, changed.');
    watch.emit('change', p);
    await w.whenIdle();
    const after = readIndex().files[p]!.sections.map((s) => s.location);
    expect([...api.embedded.keys()].sort()).toEqual([...after].sort());
    expect(after).not.toEqual(before);
    expect(readIndex().pending).toBeUndefined();
  });

  it('clears every document of the workspace, also those the index does not list', async () => {
    const watch = manualWatch();
    const { w, logs } = make({ watch });
    await w.start();
    const p = write('a.md', 'Text.');
    watch.emit('add', p);
    await w.whenIdle();
    api.embedded.set('askfiles/unlisted.md-000000000000-1-1.json', 'x');
    await w.stop();
    await w.clearIndex();
    expect(api.embedded.size).toBe(0);
    expect(readIndex().files).toEqual({});
    expect(logs).toContain('index cleared, 2 documents removed (1 listed, 1 not listed)');
  });

  describe('added files', () => {
    let other: string;
    beforeEach(() => {
      other = path.join(tmp, 'Desktop');
      fs.mkdirSync(other);
    });
    const put = (dir: string, name: string, text: string) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, text);
      return p;
    };

    /** A manual watch that also records what each watch was asked for. */
    function recordingWatch() {
      const inner = manualWatch();
      const opened: { root: string; options?: WatchOptions }[] = [];
      const f = ((r, onEvent, onError, options) => {
        opened.push({ root: r, options });
        return inner(r, onEvent, onError, options);
      }) as WatchFactory;
      return { f, opened, emit: inner.emit };
    }

    it('watches each added file through its folder, one watch per folder, depth 0', async () => {
      const a = put(other, 'a.md', 'A.');
      const b = put(other, 'b.md', 'B.');
      put(other, 'not-added.md', 'Never indexed.');
      const watch = recordingWatch();
      const { w } = make({
        watch: watch.f,
        roots: [
          { id: 'file-1', path: a, label: '', file: true },
          { id: 'file-2', path: b, label: '', file: true },
        ],
      });
      await w.start();
      await w.whenIdle();
      expect(watch.opened).toEqual([{ root: other, options: { depth: 0, only: new Set([a, b]) } }]);
      expect(Object.keys(readIndex().files).sort()).toEqual([a, b]);
      expect(readIndex().files[a]).toMatchObject({ sourceId: 'file-1', relPath: 'a.md' });

      // Events for other files of the folder are not the library's.
      watch.emit('add', path.join(other, 'not-added.md'));
      await w.whenIdle();
      expect(Object.keys(readIndex().files)).toHaveLength(2);
    });

    it('adds and removes added files while running', async () => {
      const watch = recordingWatch();
      const { w, events } = make({ watch: watch.f, roots: [] });
      await w.start();
      const a = put(other, 'a.md', 'A.');
      const b = put(root, 'b.md', 'B.');
      await w.addRoots([
        { id: 'file-1', path: a, label: '', file: true },
        { id: 'file-2', path: b, label: '', file: true },
      ]);
      await w.whenIdle();
      expect(watch.opened.map((o) => o.root).sort()).toEqual([other, root].sort());
      expect(Object.keys(readIndex().files).sort()).toEqual([a, b].sort());

      // A third file in a folder already watched joins its watch.
      const c = put(other, 'c.md', 'C.');
      await w.addRoots([{ id: 'file-3', path: c, label: '', file: true }]);
      await w.whenIdle();
      expect(watch.opened).toHaveLength(2);
      expect([...watch.opened.find((o) => o.root === other)!.options!.only!]).toEqual([a, c]);

      // A change event re-indexes it; removing its root removes it from the index.
      fs.writeFileSync(c, 'C, changed.');
      watch.emit('change', c);
      await w.whenIdle();
      expect(events.filter((e) => e.path === c).map((e) => e.outcome)).toEqual(['indexed', 'indexed']);
      w.removeRoot('file-3');
      await w.whenIdle();
      expect(readIndex().files[c]).toBeUndefined();
      expect([...watch.opened.find((o) => o.root === other)!.options!.only!]).toEqual([a]);
      await expect(w.addRoots([{ id: 'folder-1', path: root, label: 'Documents' }])).rejects.toThrow(
        /added files only/,
      );
    });

    it('removes an added file whose original is gone at start, keeps one whose folder cannot be read', async () => {
      const a = put(other, 'a.md', 'A.');
      const drive = path.join(tmp, 'Volume');
      fs.mkdirSync(drive);
      const b = put(drive, 'b.md', 'B.');
      const roots: WatchRoot[] = [
        { id: 'file-1', path: a, label: '', file: true },
        { id: 'file-2', path: b, label: '', file: true },
      ];
      const first = make({ roots });
      await first.w.start();
      await first.w.whenIdle();
      await first.w.stop();
      fs.rmSync(a);
      fs.rmSync(drive, { recursive: true });
      const second = make({ roots });
      await second.w.start();
      await second.w.whenIdle();
      expect(Object.keys(readIndex().files)).toEqual([b]);
      expect(second.w.status().unavailable).toEqual([b]);
      expect(second.events).toEqual([expect.objectContaining({ path: a, outcome: 'removed' })]);
    });

    it('checks for updates while running: only a file whose size or time changed is looked at', async () => {
      const a = put(other, 'a.md', 'A.');
      const b = put(other, 'b.md', 'B.');
      const splitter = countingSplitter();
      const { w } = make({
        splitter,
        roots: [
          { id: 'file-1', path: a, label: '', file: true },
          { id: 'file-2', path: b, label: '', file: true },
        ],
      });
      await w.start();
      await w.whenIdle();
      fs.writeFileSync(a, 'A, changed while no event came.');
      const calls = splitter.calls.length;
      expect(await w.checkNow()).toEqual({ toCheck: 1 });
      expect(w.status()).toMatchObject({ state: 'working', pending: 1 });
      await w.whenIdle();
      expect(splitter.calls.slice(calls)).toEqual([a]);
      expect(await w.checkNow()).toEqual({ toCheck: 0 });
    });

    it('follows an added file with the real chokidar watch, ignoring its neighbours', async () => {
      const a = put(other, 'live.md', 'First.');
      const splitter = countingSplitter();
      const { w } = make({
        watch: chokidarWatch,
        splitter,
        roots: [{ id: 'file-1', path: a, label: '', file: true }],
      });
      await w.start();
      await w.whenIdle();
      const first = readIndex().files[a]!.hash;
      put(other, 'neighbour.md', 'Not added.');
      // On macOS the folder watch can take a moment to arm after ready, more so while other test
      // files load the machine; a change in that moment is caught by the next reconcile in the app.
      // Here the file is written again until the watch reports it.
      const deadline = Date.now() + 10_000;
      for (let n = 2; readIndex().files[a]?.hash === first; n++) {
        if (Date.now() > deadline) throw new Error('chokidar did not report the change within 10 s');
        if (n % 20 === 2) fs.writeFileSync(a, `Version ${n}.`);
        await new Promise((r) => setTimeout(r, 50));
      }
      fs.rmSync(a);
      while (readIndex().files[a]) {
        if (Date.now() > deadline) throw new Error('chokidar did not report the deletion within 10 s');
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(splitter.calls.every((c) => c === a)).toBe(true);
      expect(api.embedded.size).toBe(0);
    });
  });
});
