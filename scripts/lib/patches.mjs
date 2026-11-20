// Lists the unified diffs in patches/, applies them to a copy of upstream/ and checks that a tree
// holds them. upstream/ itself is never patched: scripts/lib/upstream-copy.mjs copies it into
// upstream-build/run and applies the patches there, and packaging checks the packaged app with check.
// Usage: node scripts/lib/patches.mjs check <dir> [repoRoot]
//   dir  holds server/ and collector/ like upstream/, for example the app's Contents/Resources
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PATCH_FILE = /\.(patch|diff)$/;

/** Patch files in name order, so 001-... applies before 002-.... README and other files are ignored. */
export function listPatches(patchesDir) {
  return readdirSync(patchesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PATCH_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function gitApply(dir, args, patchPath) {
  // Patches are written relative to upstream/ (a/server/index.js), so they apply with dir as the
  // working directory. The ceiling keeps git from finding a repository above dir: inside this
  // repository git would read the paths relative to its top level instead.
  return spawnSync('git', ['apply', ...args, patchPath], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(resolve(dir)) },
  });
}

/**
 * Applies every patch to dir, a fresh copy of upstream/. Throws on the first patch that does not
 * apply, before touching any file for that patch.
 */
export function applyPatches({ dir, patchesDir, log = console.log }) {
  const results = [];
  for (const name of listPatches(patchesDir)) {
    const patchPath = join(patchesDir, name);
    const check = gitApply(dir, ['--check'], patchPath);
    if (check.status !== 0) {
      throw new Error(
        `patch ${name} does not apply to upstream/. Upstream changed or the patch is stale; ` +
          `refresh it against the tag in UPSTREAM_VERSION.\n${(check.stderr || '').trim()}`,
      );
    }
    const apply = gitApply(dir, [], patchPath);
    if (apply.status !== 0) {
      throw new Error(`patch ${name} passed --check but failed to apply:\n${(apply.stderr || '').trim()}`);
    }
    log(`[build] patch ${name} applied`);
    results.push({ name, action: 'applied' });
  }
  return results;
}

/** Paths a patch changes, relative to upstream/ (the +++ b/... lines). */
export function patchedFiles(patchText) {
  return [...patchText.matchAll(/^\+\+\+ b\/(.+?)\s*$/gm)].map((m) => m[1]);
}

/**
 * Which patches dir holds. The files the patches change are copied to a temporary folder and the
 * patches reverted there last first, as several patches change the same file (001, 004 and 005 all
 * change server/index.js): a patch counts as applied when it reverts cleanly after the later ones.
 * dir is only read.
 */
export function checkPatches({ dir, patchesDir }) {
  const names = listPatches(patchesDir);
  const work = mkdtempSync(join(tmpdir(), 'askfiles-patch-check-'));
  try {
    for (const name of names) {
      for (const rel of patchedFiles(readFileSync(join(patchesDir, name), 'utf8'))) {
        const from = join(dir, rel);
        if (!existsSync(from)) continue;
        mkdirSync(dirname(join(work, rel)), { recursive: true });
        copyFileSync(from, join(work, rel));
      }
    }
    const applied = new Map();
    for (const name of [...names].reverse()) {
      applied.set(name, gitApply(work, ['--reverse'], join(patchesDir, name)).status === 0);
    }
    return names.map((name) => ({ name, applied: applied.get(name) }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, dir, repoRoot] = process.argv.slice(2);
  if (command !== 'check' || !dir) {
    console.error('usage: node scripts/lib/patches.mjs check <dir> [repoRoot]');
    process.exit(2);
  }
  const root = repoRoot ? resolve(repoRoot) : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const results = checkPatches({ dir: resolve(dir), patchesDir: join(root, 'patches') });
  const missing = results.filter((r) => !r.applied).map((r) => r.name);
  if (results.length === 0) {
    console.error(`[patches] ERROR: no patches found in ${join(root, 'patches')}`);
    process.exit(1);
  }
  if (missing.length) {
    console.error(
      `[patches] ERROR: ${dir} lacks ${missing.length} of ${results.length} patches: ${missing.join(', ')}`,
    );
    process.exit(1);
  }
  console.log(`[patches] ok: all ${results.length} patches are applied in ${dir}`);
}
