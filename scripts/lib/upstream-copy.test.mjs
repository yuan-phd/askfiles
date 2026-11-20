import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_DIR, sourceHash, syncRunCopy, upstreamState } from './upstream-copy.mjs';

// A small invented repository: upstream/ with a server and a collector, and one patch.
const PATCH = `--- a/server/greeting.txt
+++ b/server/greeting.txt
@@ -1,2 +1,2 @@
 hello
-world
+patched world
`;

let root;
let run;
const quiet = () => {};
const sync = () => syncRunCopy({ root, log: quiet });

function git(...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

function write(rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'askfiles-upstream-copy-'));
  run = join(root, RUN_DIR);
  git('init', '-q');
  write('.gitignore', '/upstream-build/\n');
  write('upstream/server/greeting.txt', 'hello\nworld\n');
  write('upstream/server/start.sh', '#!/bin/sh\necho start\n');
  chmodSync(join(root, 'upstream/server/start.sh'), 0o755);
  write('upstream/collector/index.js', 'module.exports = 1;\n');
  write('upstream/frontend/package.json', '{}\n');
  write('patches/001-greeting.patch', PATCH);
  symlinkSync('greeting.txt', join(root, 'upstream/server/greeting-link.txt'));
  git('add', '-A');
  // A submodule entry that was never initialized, as upstream/embed is: an empty folder in git's index.
  mkdirSync(join(root, 'upstream/embed'));
  git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},upstream/embed`);
  git('commit', '-q', '-m', 'fixture');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const status = () => git('status', '--porcelain', '--ignored', '--', 'upstream');

describe('syncRunCopy', () => {
  it('copies the tracked upstream/ files into upstream-build/run, applies the patches there and leaves upstream/ as it was', () => {
    expect(sync()).toBe('copied');
    expect(readFileSync(join(run, 'server/greeting.txt'), 'utf8')).toBe('hello\npatched world\n');
    expect(readFileSync(join(run, 'collector/index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(root, 'upstream/server/greeting.txt'), 'utf8')).toBe('hello\nworld\n');
    expect(status()).toBe('');
  });

  it('copies links as links and skips submodule entries', () => {
    sync();
    expect(readlinkSync(join(run, 'server/greeting-link.txt'))).toBe('greeting.txt');
    expect(existsSync(join(run, 'embed'))).toBe(false);
  });

  it('keeps the executable bit', () => {
    sync();
    expect(statSync(join(run, 'server/start.sh')).mode & 0o111).not.toBe(0);
  });

  it('touches nothing when upstream/ and patches/ are unchanged', () => {
    sync();
    writeFileSync(join(run, 'server/runtime.log'), 'left by a run');
    expect(sync()).toBe('current');
    expect(existsSync(join(run, 'server/runtime.log'))).toBe(true);
  });

  it('copies again when a patch changes, keeping installed packages and the frontend build', () => {
    sync();
    for (const rel of [
      'server/node_modules/a/index.js',
      'collector/node_modules/b/index.js',
      'frontend/dist/_index.html',
    ]) {
      mkdirSync(dirname(join(run, rel)), { recursive: true });
      writeFileSync(join(run, rel), 'built');
    }
    writeFileSync(join(run, 'server/runtime.log'), 'left by a run');
    write('patches/001-greeting.patch', PATCH.replace('+patched world', '+changed world'));
    expect(sync()).toBe('copied');
    expect(readFileSync(join(run, 'server/greeting.txt'), 'utf8')).toBe('hello\nchanged world\n');
    expect(existsSync(join(run, 'server/runtime.log'))).toBe(false);
    for (const rel of [
      'server/node_modules/a/index.js',
      'collector/node_modules/b/index.js',
      'frontend/dist/_index.html',
    ]) {
      expect(readFileSync(join(run, rel), 'utf8')).toBe('built');
    }
  });

  it('copies again when a tracked upstream/ file changes, even before a commit', () => {
    sync();
    const before = sourceHash(root);
    write('upstream/collector/index.js', 'module.exports = 2;\n');
    expect(sourceHash(root)).not.toBe(before);
    expect(sync()).toBe('copied');
    expect(readFileSync(join(run, 'collector/index.js'), 'utf8')).toBe('module.exports = 2;\n');
  });

  it('leaves out files in upstream/ that git does not track', () => {
    write('upstream/server/local-notes.txt', 'not tracked');
    sync();
    expect(existsSync(join(run, 'server/local-notes.txt'))).toBe(false);
  });

  it('fails on a patch that does not apply and leaves no stamp, so the next run copies again', () => {
    write('patches/002-bad.patch', PATCH.replace('-world', '-missing line'));
    expect(sync).toThrow(/002-bad\.patch does not apply/);
    rmSync(join(root, 'patches/002-bad.patch'));
    expect(sync()).toBe('copied');
  });
});

describe('upstreamState', () => {
  it('changes when a file is added to upstream/, even an ignored one, and when a tracked file is edited', () => {
    const clean = upstreamState(root);
    write('upstream/server/new.txt', 'x');
    const added = upstreamState(root);
    expect(added).not.toBe(clean);
    rmSync(join(root, 'upstream/server/new.txt'));
    expect(upstreamState(root)).toBe(clean);
    write('.gitignore', '/upstream-build/\nupstream/server/public/\n');
    write('upstream/server/public/index.html', 'built');
    expect(upstreamState(root)).not.toBe(clean);
    rmSync(join(root, 'upstream/server/public'), { recursive: true });
    write('upstream/server/greeting.txt', 'hello\nedited\n');
    expect(upstreamState(root)).not.toBe(clean);
  });

  it('does not change when only upstream-build/ is written', () => {
    const clean = upstreamState(root);
    sync();
    expect(upstreamState(root)).toBe(clean);
  });
});
