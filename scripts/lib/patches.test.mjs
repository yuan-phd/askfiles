import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPatches, listPatches, restorePatches } from './patches.mjs';

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
const quiet = () => {};
const file = () => readFileSync(join(root, 'upstream/server/file.txt'), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'askfiles-patches-'));
  mkdirSync(join(root, 'upstream/server'), { recursive: true });
  mkdirSync(join(root, 'patches'));
  writeFileSync(join(root, 'upstream/server/file.txt'), ORIGINAL);
  writeFileSync(join(root, 'patches/README.md'), 'not a patch');
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
  it('applies patches in order into upstream/', () => {
    writeFileSync(join(root, 'patches/002-three.patch'), CHANGE_THREE);
    writeFileSync(join(root, 'patches/001-two.patch'), CHANGE_TWO);
    const results = applyPatches({ repoRoot: root, log: quiet });
    expect(results).toEqual([
      { name: '001-two.patch', action: 'applied' },
      { name: '002-three.patch', action: 'applied' },
    ]);
    expect(file()).toBe('one\nTWO\nTHREE\n');
  });

  it('is idempotent: a second run skips patches already applied', () => {
    writeFileSync(join(root, 'patches/001-two.patch'), CHANGE_TWO);
    applyPatches({ repoRoot: root, log: quiet });
    const again = applyPatches({ repoRoot: root, log: quiet });
    expect(again).toEqual([{ name: '001-two.patch', action: 'skipped' }]);
    expect(file()).toBe('one\nTWO\nthree\n');
  });

  it('stops with the patch name on a patch that does not apply and leaves the file untouched', () => {
    writeFileSync(join(root, 'patches/001-bad.patch'), CONFLICT);
    expect(() => applyPatches({ repoRoot: root, log: quiet })).toThrow(/001-bad\.patch does not apply/);
    expect(file()).toBe(ORIGINAL);
  });

  it('applies earlier patches and stops at the first failing one', () => {
    writeFileSync(join(root, 'patches/001-two.patch'), CHANGE_TWO);
    writeFileSync(join(root, 'patches/002-bad.patch'), CONFLICT);
    expect(() => applyPatches({ repoRoot: root, log: quiet })).toThrow(/002-bad\.patch/);
    expect(file()).toBe('one\nTWO\nthree\n');
  });
});

describe('restorePatches', () => {
  it('reverts stacked patches last first and leaves the file as committed', () => {
    writeFileSync(join(root, 'patches/001-two.patch'), CHANGE_TWO);
    writeFileSync(join(root, 'patches/002-three.patch'), CHANGE_THREE);
    applyPatches({ repoRoot: root, log: quiet });
    expect(file()).toBe('one\nTWO\nTHREE\n');
    const results = restorePatches({ repoRoot: root, log: quiet });
    expect(results).toEqual([
      { name: '002-three.patch', action: 'reverted' },
      { name: '001-two.patch', action: 'reverted' },
    ]);
    expect(file()).toBe(ORIGINAL);
  });

  it('skips patches that are not applied, so a second restore changes nothing', () => {
    writeFileSync(join(root, 'patches/001-two.patch'), CHANGE_TWO);
    applyPatches({ repoRoot: root, log: quiet });
    restorePatches({ repoRoot: root, log: quiet });
    expect(restorePatches({ repoRoot: root, log: quiet })).toEqual([{ name: '001-two.patch', action: 'skipped' }]);
    expect(file()).toBe(ORIGINAL);
  });

  it('stops with the patch name when a patched file was edited by hand and leaves it as it is', () => {
    writeFileSync(join(root, 'patches/001-two.patch'), CHANGE_TWO);
    writeFileSync(join(root, 'upstream/server/file.txt'), 'one\nedited\nthree\n');
    expect(() => restorePatches({ repoRoot: root, log: quiet })).toThrow(/001-two\.patch is neither applied/);
    expect(file()).toBe('one\nedited\nthree\n');
  });

  it('applies again after a restore', () => {
    writeFileSync(join(root, 'patches/001-two.patch'), CHANGE_TWO);
    applyPatches({ repoRoot: root, log: quiet });
    restorePatches({ repoRoot: root, log: quiet });
    expect(applyPatches({ repoRoot: root, log: quiet })).toEqual([{ name: '001-two.patch', action: 'applied' }]);
    expect(file()).toBe('one\nTWO\nthree\n');
  });
});
