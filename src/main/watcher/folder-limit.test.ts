import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countFolders, WATCH_FOLDER_LIMIT, WatchBudget } from './folder-limit.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-count-')));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function dirs(...rels: string[]): void {
  for (const r of rels) fs.mkdirSync(path.join(tmp, r), { recursive: true });
}

/** n invented folders below top, ten to a parent, each with one note. */
function tree(top: string, n: number): void {
  fs.mkdirSync(top, { recursive: true });
  const queue = [top];
  let made = 0;
  while (made < n) {
    const parent = queue.shift()!;
    for (let i = 0; i < 10 && made < n; i++, made++) {
      const d = path.join(parent, `part-${i}`);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'note.md'), '# Note\n');
      queue.push(d);
    }
  }
}

describe('countFolders', () => {
  it('counts every folder below the root that is not skipped, not the root itself', async () => {
    dirs('Docs/HR/2026', 'Docs/Finance', 'Docs/build', 'Docs/dist/old');
    dirs('Docs/.git/objects/aa', 'Docs/app/node_modules/pkg/lib', 'Docs/py/__pycache__', 'Docs/Tool.app/Contents');
    dirs(
      'Docs/$RECYCLE.BIN/x',
      'Docs/System Volume Information',
      'Docs/Letter.pages/Data',
      'Docs/Photos.photoslibrary/a',
    );
    dirs('Docs/py/env/lib/site-packages/pkg');
    fs.writeFileSync(path.join(tmp, 'Docs/py/env/pyvenv.cfg'), 'home = /usr/bin\n');
    const r = await countFolders([{ path: path.join(tmp, 'Docs'), recursive: true }]);
    // HR, 2026, Finance, build, dist, old, app, py; not Docs, the linked folder.
    expect(r).toEqual({ count: 8, over: false });
  });

  it('counts the folder of added files once, and not again when a linked folder holds it', async () => {
    dirs('Docs/HR', 'Desktop', 'Downloads/sub');
    const r = await countFolders([
      { path: path.join(tmp, 'Docs'), recursive: true },
      { path: path.join(tmp, 'Desktop'), recursive: false },
      { path: path.join(tmp, 'Desktop'), recursive: false },
      { path: path.join(tmp, 'Downloads'), recursive: false },
      { path: path.join(tmp, 'Docs', 'HR'), recursive: false },
    ]);
    // HR (walked), Desktop, Downloads (not its sub folder); not Docs, the linked folder.
    expect(r).toEqual({ count: 3, over: false });
  });

  it('stops as soon as the count passes the limit, and lets exactly the limit through', async () => {
    tree(path.join(tmp, 'Big'), 500);
    const r = await countFolders([{ path: path.join(tmp, 'Big'), recursive: true }], { stopAbove: 100 });
    expect(r).toEqual({ count: 101, over: true });
    // 500 subfolders against a limit of 500: the linked folder itself does not count.
    expect(await countFolders([{ path: path.join(tmp, 'Big'), recursive: true }], { stopAbove: 500 })).toEqual({
      count: 500,
      over: false,
    });
    expect(await countFolders([{ path: path.join(tmp, 'Big'), recursive: true }], { stopAbove: 499 })).toEqual({
      count: 500,
      over: true,
    });
  });

  it('gives the event loop a turn between folders, so the window keeps getting events', async () => {
    // A small tree, on purpose: making and removing thousands of folders floods the system's
    // FSEvents service and delays the live events the other test files wait for. Yielding per
    // folder is what keeps a count of any size from blocking (measured: docs/app.md).
    tree(path.join(tmp, 'Wide'), 300);
    let turns = 0;
    let on = true;
    const tick = () => {
      turns++;
      if (on) setImmediate(tick);
    };
    setImmediate(tick);
    const r = await countFolders([{ path: path.join(tmp, 'Wide'), recursive: true }], { stopAbove: 200 });
    on = false;
    expect(r).toEqual({ count: 201, over: true });
    // One read per folder, each awaited: the loop turns at least about once per folder read.
    expect(turns).toBeGreaterThan(150);
  });
});

describe('WatchBudget', () => {
  it('admits folders up to the limit, shares them across watches, and frees them on release', () => {
    const b = new WatchBudget(3);
    const one = new Set<string>();
    const two = new Set<string>();
    expect(['/a', '/b', '/c'].map((d) => b.admit(d, one))).toEqual([true, true, true]);
    expect(b.admit('/d', two)).toBe(false);
    // A folder already watched is no second watch.
    expect(b.admit('/a', two)).toBe(true);
    b.release(one);
    expect(b.size).toBe(0);
    expect(b.admit('/d', two)).toBe(true);
  });

  it('lets the root of a linked folder through without taking a place', () => {
    const b = new WatchBudget(2);
    const w = new Set<string>();
    expect(b.admit('/Docs', w, { counts: false })).toBe(true);
    expect(['/Docs/a', '/Docs/b', '/Docs/c'].map((d) => b.admit(d, w))).toEqual([true, true, false]);
    expect(b.size).toBe(2);
    // A second linked folder is still watched at the limit; its subfolders are not.
    expect(b.admit('/Mail', w, { counts: false })).toBe(true);
    expect(b.admit('/Mail/x', w)).toBe(false);
    b.release(w);
    expect(b.size).toBe(0);
    expect(['/Mail/x', '/Mail/y'].map((d) => b.admit(d, w))).toEqual([true, true]);
  });

  it('defaults to 1,000 subfolders, where closing the watches froze the window for 2.9 s', () => {
    expect(WATCH_FOLDER_LIMIT).toBe(1000);
    expect(new WatchBudget().limit).toBe(1000);
  });
});
