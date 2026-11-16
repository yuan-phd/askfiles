// Lists, applies and reverts the unified diffs in patches/ in upstream/. apply is called by
// scripts/build.sh and npm run dev; restore by the packaging commands once electron-builder has
// copied the patched tree, so upstream/ is back at its committed state after a package run.
// Usage: node scripts/lib/patches.mjs apply|restore <repoRoot>
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATCH_FILE = /\.(patch|diff)$/;

/** Patch files in name order, so 001-... applies before 002-.... README and other files are ignored. */
export function listPatches(patchesDir) {
  return readdirSync(patchesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PATCH_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function gitApply(repoRoot, upstreamDir, args, patchPath) {
  // Patches are written relative to upstream/ (a/server/index.js), so --directory maps them into
  // the subtree whether or not repoRoot is a git work tree.
  return spawnSync('git', ['apply', `--directory=${upstreamDir}`, ...args, patchPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

/**
 * Applies every patch that is not applied yet. A patch whose reverse applies cleanly is treated as
 * already applied, which makes repeated builds idempotent. Throws on the first patch that neither
 * applies nor is already applied, before touching any file for that patch.
 */
export function applyPatches({
  repoRoot,
  patchesDir = join(repoRoot, 'patches'),
  upstreamDir = 'upstream',
  log = console.log,
}) {
  const results = [];
  for (const name of listPatches(patchesDir)) {
    const patchPath = join(patchesDir, name);
    if (gitApply(repoRoot, upstreamDir, ['--reverse', '--check'], patchPath).status === 0) {
      log(`[build] patch ${name} already applied`);
      results.push({ name, action: 'skipped' });
      continue;
    }
    const check = gitApply(repoRoot, upstreamDir, ['--check'], patchPath);
    if (check.status !== 0) {
      throw new Error(
        `patch ${name} does not apply to ${upstreamDir}/. Upstream changed or the patch is stale; ` +
          `refresh it against the tag in UPSTREAM_VERSION.\n${(check.stderr || '').trim()}`,
      );
    }
    const apply = gitApply(repoRoot, upstreamDir, [], patchPath);
    if (apply.status !== 0) {
      throw new Error(`patch ${name} passed --check but failed to apply:\n${(apply.stderr || '').trim()}`);
    }
    log(`[build] patch ${name} applied`);
    results.push({ name, action: 'applied' });
  }
  return results;
}

/**
 * Reverts every applied patch, last patch first: a later patch may change lines an earlier one
 * added, so the earlier one only reverts once the later one is gone. A patch that is not applied
 * is skipped. Throws on a patch that is neither applied nor cleanly unapplied (upstream/ was
 * edited by hand), leaving that patch's files as they are. Only the patches' own lines change, so
 * anything else edited under upstream/ stays visible in git status.
 */
export function restorePatches({
  repoRoot,
  patchesDir = join(repoRoot, 'patches'),
  upstreamDir = 'upstream',
  log = console.log,
}) {
  const results = [];
  for (const name of listPatches(patchesDir).reverse()) {
    const patchPath = join(patchesDir, name);
    if (gitApply(repoRoot, upstreamDir, ['--reverse', '--check'], patchPath).status === 0) {
      const revert = gitApply(repoRoot, upstreamDir, ['--reverse'], patchPath);
      if (revert.status !== 0) {
        throw new Error(
          `patch ${name} passed --reverse --check but failed to revert:\n${(revert.stderr || '').trim()}`,
        );
      }
      log(`[build] patch ${name} reverted`);
      results.push({ name, action: 'reverted' });
      continue;
    }
    if (gitApply(repoRoot, upstreamDir, ['--check'], patchPath).status === 0) {
      results.push({ name, action: 'skipped' });
      continue;
    }
    throw new Error(
      `patch ${name} is neither applied nor cleanly unapplied in ${upstreamDir}/; its files were edited ` +
        `by hand. Check git status ${upstreamDir}/ and restore them with git checkout -- <file>.`,
    );
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, repoRoot] = process.argv.slice(2);
  if ((command !== 'apply' && command !== 'restore') || !repoRoot) {
    console.error('usage: node scripts/lib/patches.mjs apply|restore <repoRoot>');
    process.exit(2);
  }
  try {
    if (command === 'restore') {
      const reverted = restorePatches({ repoRoot: resolve(repoRoot) }).filter((r) => r.action === 'reverted');
      console.log(`[build] upstream/ restored: ${reverted.length} patches reverted`);
      process.exit(0);
    }
    const results = applyPatches({ repoRoot: resolve(repoRoot) });
    if (results.length === 0) console.log('[build] no patches to apply');
  } catch (err) {
    console.error(`[build] ERROR: ${err.message}`);
    process.exit(1);
  }
}
