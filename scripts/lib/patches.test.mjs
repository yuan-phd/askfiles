import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPatches, checkPatches, listPatches, patchedFiles } from './patches.mjs';

const ORIGINAL = 'one\ntwo\nthree\n';

// Paths are relative to upstream/, the convention for files in patches/.
const CHANGE_TWO = `--- a/server/file.txt
+++ b/server/file.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

const CHANGE_THREE = `--- a/server/file.txt
+++ b/server/file.txt
@@ -1,3 +1,3 @@
 one
 TWO
-three
+THREE
`;

const CONFLICT = `--- a/server/file.txt
+++ b/server/file.txt
@@ -1,3 +1,3 @@
 one
-missing line
+x
 three
`;

let root;
let dir;
let patchesDir;
const quiet = () => {};
const file = () => readFileSync(join(dir, 'server/file.txt'), 'utf8');
const apply = () => applyPatches({ dir, patchesDir, log: quiet });

// dir stands for a copy of upstream/ (or a packaged app's Resources); it sits inside a git
// repository, as upstream-build/run does, so the tests also cover git reading the patch paths
// relative to dir rather than to the repository.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'askfiles-patches-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  dir = join(root, 'upstream-build/run');
  patchesDir = join(root, 'patches');
  mkdirSync(join(dir, 'server'), { recursive: true });
  mkdirSync(patchesDir);
  writeFileSync(join(dir, 'server/file.txt'), ORIGINAL);
  writeFileSync(join(patchesDir, 'README.md'), 'not a patch');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('listPatches', () => {
  it('returns .patch and .diff files in name order and ignores other files', () => {
    writeFileSync(join(root, 'patches/010-b.diff'), '');
    writeFileSync(join(root, 'patches/002-a.patch'), '');
    writeFileSync(join(root, 'patches/notes.txt'), '');
    mkdirSync(join(root, 'patches/001-dir.patch'));
    expect(listPatches(join(root, 'patches'))).toEqual(['002-a.patch', '010-b.diff']);
  });

  it('returns an empty list when there are no patches', () => {
    expect(listPatches(join(root, 'patches'))).toEqual([]);
  });
});

describe('applyPatches', () => {
  it('applies patches in order into the copy', () => {
    writeFileSync(join(patchesDir, '002-three.patch'), CHANGE_THREE);
    writeFileSync(join(patchesDir, '001-two.patch'), CHANGE_TWO);
    expect(apply()).toEqual([
      { name: '001-two.patch', action: 'applied' },
      { name: '002-three.patch', action: 'applied' },
    ]);
    expect(file()).toBe('one\nTWO\nTHREE\n');
  });

  it('stops with the patch name on a patch that does not apply and leaves the file untouched', () => {
    writeFileSync(join(patchesDir, '001-bad.patch'), CONFLICT);
    expect(apply).toThrow(/001-bad\.patch does not apply/);
    expect(file()).toBe(ORIGINAL);
  });

  it('applies earlier patches and stops at the first failing one', () => {
    writeFileSync(join(patchesDir, '001-two.patch'), CHANGE_TWO);
    writeFileSync(join(patchesDir, '002-bad.patch'), CONFLICT);
    expect(apply).toThrow(/002-bad\.patch/);
    expect(file()).toBe('one\nTWO\nthree\n');
  });
});

describe('patchedFiles', () => {
  it('lists the files a patch changes, relative to upstream/', () => {
    expect(patchedFiles(CHANGE_TWO)).toEqual(['server/file.txt']);
  });
});

describe('checkPatches', () => {
  it('reports every patch applied in a tree that holds them, including patches stacked on one file', () => {
    writeFileSync(join(patchesDir, '001-two.patch'), CHANGE_TWO);
    writeFileSync(join(patchesDir, '002-three.patch'), CHANGE_THREE);
    apply();
    expect(checkPatches({ dir, patchesDir })).toEqual([
      { name: '001-two.patch', applied: true },
      { name: '002-three.patch', applied: true },
    ]);
  });

  it('reports the patches a tree lacks', () => {
    writeFileSync(join(patchesDir, '001-two.patch'), CHANGE_TWO);
    expect(checkPatches({ dir, patchesDir })).toEqual([{ name: '001-two.patch', applied: false }]);
    writeFileSync(join(patchesDir, '002-three.patch'), CHANGE_THREE);
    writeFileSync(join(dir, 'server/file.txt'), 'one\nTWO\nthree\n');
    expect(checkPatches({ dir, patchesDir })).toEqual([
      { name: '001-two.patch', applied: true },
      { name: '002-three.patch', applied: false },
    ]);
  });

  it('reports a patch as missing when its file is gone', () => {
    writeFileSync(join(patchesDir, '001-two.patch'), CHANGE_TWO);
    rmSync(join(dir, 'server/file.txt'));
    expect(checkPatches({ dir, patchesDir })).toEqual([{ name: '001-two.patch', applied: false }]);
  });

  it('only reads the tree it checks', () => {
    writeFileSync(join(patchesDir, '001-two.patch'), CHANGE_TWO);
    writeFileSync(join(patchesDir, '002-three.patch'), CHANGE_THREE);
    apply();
    checkPatches({ dir, patchesDir });
    expect(file()).toBe('one\nTWO\nTHREE\n');
  });
});
