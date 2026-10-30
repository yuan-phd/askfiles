import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countingSplitter, fakeApi } from './__fixtures__/fakes.js';
import type { IndexData, WatchFactory } from './types.js';
import { FolderWatcher, type WatchRoot } from './watcher.js';

let tmp: string;
let dataDir: string;
let storageDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-roots-')));
  dataDir = path.join(tmp, 'data', 'libraries', 'lib-1');
  storageDir = path.join(tmp, 'data', 'storage');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const noWatch: WatchFactory = () => ({ ready: Promise.resolve(), close: async () => {} });

function put(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function watcherFor(roots: WatchRoot[], api = fakeApi(storageDir)) {
  return {
    api,
    watcher: new FolderWatcher({
      roots,
      dataDir,
      storageDir,
      docsFolder: 'askfiles/lib-1',
      workspaceSlug: 'lib-1-ws',
      api,
      splitter: countingSplitter(),
      watch: noWatch,
      debounceMs: 5,
      stableMs: 5,
      log: () => {},
    }),
  };
}

const index = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8')) as IndexData;

async function run(w: FolderWatcher) {
  await w.start();
  await w.whenIdle();
  await w.stop();
}

describe('FolderWatcher with several folders (library sources)', () => {
  it('indexes every root under the library docs folder, with the folder name in the shown path', async () => {
    const a = put(path.join(tmp, 'Work', 'Docs', 'plan.md'), '# Plan\n\nThe plan.');
    const b = put(path.join(tmp, 'Home', 'Docs', 'plan.md'), '# Plan\n\nThe plan.');
    const c = put(path.join(tmp, 'data', 'libraries', 'lib-1', 'files', 'notes.md'), '# Notes\n\nA note.');
    const { watcher, api } = watcherFor([
      { id: 'files', path: path.dirname(c), label: '' },
      { id: 'folder-1', path: path.join(tmp, 'Work', 'Docs'), label: 'Docs' },
      { id: 'folder-2', path: path.join(tmp, 'Home', 'Docs'), label: 'Docs' },
    ]);
    await run(watcher);
    const files = index().files;
    expect(Object.keys(files).sort()).toEqual([a, b, c].sort());
    expect([files[a]!.relPath, files[a]!.sourceId]).toEqual([path.join('Docs', 'plan.md'), 'folder-1']);
    expect([files[c]!.relPath, files[c]!.sourceId]).toEqual(['notes.md', 'files']);
    // Same bytes and same shown path, yet different document names: the source id keeps them apart.
    const la = files[a]!.sections.map((s) => s.location);
    const lb = files[b]!.sections.map((s) => s.location);
    expect(la.every((l) => l.startsWith('askfiles/lib-1/'))).toBe(true);
    expect(la.some((l) => lb.includes(l))).toBe(false);
    expect(api.embedded.size).toBe(3);
    expect(files[a]!.sections[0]).toMatchObject({ sectionLevel: 1, sectionPath: ['Plan'], pageLabelStart: null });
  });

  it('keeps the files of a folder that cannot be read, and reports it', async () => {
    const a = put(path.join(tmp, 'Drive', 'report.md'), '# Report\n\nText.');
    const roots = [{ id: 'folder-1', path: path.join(tmp, 'Drive'), label: 'Drive' }];
    await run(watcherFor(roots).watcher);
    expect(Object.keys(index().files)).toEqual([a]);

    fs.renameSync(path.join(tmp, 'Drive'), path.join(tmp, 'Unplugged'));
    const { watcher, api } = watcherFor(roots);
    await watcher.start();
    expect(watcher.status().unavailable).toEqual([path.join(tmp, 'Drive')]);
    await watcher.whenIdle();
    await watcher.stop();
    expect(Object.keys(index().files)).toEqual([a]);
    expect(api.log.filter((l) => l.startsWith('remove'))).toEqual([]);
  });

  it('removes the files of a folder that left the library', async () => {
    const a = put(path.join(tmp, 'A', 'a.md'), '# A\n\nText a.');
    const b = put(path.join(tmp, 'B', 'b.md'), '# B\n\nText b.');
    const both = [
      { id: 'folder-1', path: path.join(tmp, 'A'), label: 'A' },
      { id: 'folder-2', path: path.join(tmp, 'B'), label: 'B' },
    ];
    const api = fakeApi(storageDir);
    await run(watcherFor(both, api).watcher);
    expect(Object.keys(index().files).sort()).toEqual([a, b]);
    await run(watcherFor([both[0]!], api).watcher);
    expect(Object.keys(index().files)).toEqual([a]);
    expect(api.embedded.size).toBe(1);
  });

  it('clears the index and its documents for a reindex, only while stopped', async () => {
    put(path.join(tmp, 'A', 'a.md'), '# A\n\nText a.');
    const roots = [{ id: 'folder-1', path: path.join(tmp, 'A'), label: 'A' }];
    const { watcher, api } = watcherFor(roots);
    await watcher.start();
    await watcher.whenIdle();
    await expect(watcher.clearIndex()).rejects.toThrow(/while idle/);
    await watcher.stop();
    await watcher.clearIndex();
    expect(index().files).toEqual({});
    expect(api.embedded.size).toBe(0);
    await run(watcher);
    expect(Object.keys(index().files)).toHaveLength(1);
    expect(api.embedded.size).toBe(1);
  });
});
