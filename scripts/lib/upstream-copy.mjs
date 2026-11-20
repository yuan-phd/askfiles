// The patched copy of upstream/ that everything runs from, so no script ever writes to upstream/.
//
// upstream-build/run      the tracked files of upstream/ with patches/ applied, plus what
//                         scripts/build.sh adds: production installs of server and collector (never
//                         pruned), the frontend build and the generated Prisma client. npm run dev,
//                         the integration and e2e stacks, the eval harness and the boot check run it.
// upstream-build/package  rebuilt from run by every package run and pruned for its platform;
//                         electron-builder copies server and collector from here.
//
// sync copies the sources again only when the tracked upstream/ files or patches/ changed (a hash
// stamped into run/.askfiles-source-stamp). It keeps the installed node_modules and the frontend
// build, whose own stamps in build.sh decide whether they are rebuilt.
// Usage: node scripts/lib/upstream-copy.mjs sync <repoRoot>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyPatches, listPatches } from './patches.mjs';

export const RUN_DIR = 'upstream-build/run';
export const PACKAGE_DIR = 'upstream-build/package';
const STAMP = '.askfiles-source-stamp';

/** Build output inside the copy that survives a source sync; build.sh checks it against its own stamps. */
export const KEPT = { server: ['node_modules'], collector: ['node_modules'], frontend: ['node_modules', 'dist'] };

export const runDir = (root) => join(root, RUN_DIR);
export const packageDir = (root) => join(root, PACKAGE_DIR);

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

/** Hash of what the copy is made from: the tracked upstream/ files as they are on disk, and the patches. */
export function sourceHash(root) {
  const hash = createHash('sha256');
  // Index entries plus any uncommitted change, so an edit counts without a commit (upstream/ is read
  // only, but a stray edit must not go unseen).
  hash.update(git(root, ['ls-files', '-s', '--', 'upstream']));
  hash.update(git(root, ['diff', 'HEAD', '--', 'upstream']));
  const patchesDir = join(root, 'patches');
  for (const name of listPatches(patchesDir)) {
    hash.update(`\0${name}\0`);
    hash.update(readFileSync(join(patchesDir, name)));
  }
  return hash.digest('hex');
}

/** Tracked entries under upstream/ with their git mode: 100644 or 100755 files, 120000 links, 160000 submodules. */
function trackedFiles(root) {
  return git(root, ['ls-files', '-s', '-z', '--', 'upstream'])
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { mode: line.slice(0, line.indexOf(' ')), rel: line.slice(tab + 1) };
    });
}

/** Whether path exists, without following a link (a link's target may be missing). */
function present(file) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Removes everything in dir except the build output listed in KEPT. */
function clearSources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const keep = entry.isDirectory() ? KEPT[entry.name] : undefined;
    if (!keep) {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
      continue;
    }
    for (const inner of readdirSync(join(dir, entry.name))) {
      if (!keep.includes(inner)) rmSync(join(dir, entry.name, inner), { recursive: true, force: true });
    }
  }
}

/**
 * Brings upstream-build/run up to date with upstream/ and patches/. Returns 'current' when the
 * stamp matched and nothing was touched, 'copied' after a fresh copy with every patch applied.
 * upstream/ is only read.
 */
export function syncRunCopy({ root, log = console.log }) {
  const run = runDir(root);
  const hash = sourceHash(root);
  const stampFile = join(run, STAMP);
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === hash) {
    log(`[build] ${RUN_DIR} matches upstream/ and patches/, sources kept`);
    return 'current';
  }
  mkdirSync(run, { recursive: true });
  // Cleared first, so a copy cut off half way never carries the stamp of a complete one.
  rmSync(stampFile, { force: true });
  clearSources(run);
  let copied = 0;
  for (const { mode, rel } of trackedFiles(root)) {
    // Submodule entries (upstream/browser-extension and upstream/embed, never initialized) hold no files.
    if (mode === '160000') continue;
    const from = join(root, rel);
    // A tracked file deleted on disk shows in git status; the copy follows the disk.
    if (!present(from)) continue;
    const to = join(run, rel.slice('upstream/'.length));
    mkdirSync(dirname(to), { recursive: true });
    if (mode === '120000') symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
    copied++;
  }
  log(`[build] copied ${copied} tracked files of upstream/ into ${RUN_DIR}`);
  applyPatches({ dir: run, patchesDir: join(root, 'patches'), log });
  writeFileSync(stampFile, hash);
  return 'copied';
}

/**
 * Runs scripts/build.sh without a package target, which syncs and builds upstream-build/run, and
 * does nothing slow when it is current. For the integration suite and the eval harness.
 */
export function buildRunCopy(root) {
  const env = { ...process.env };
  delete env.PACKAGE_TARGET;
  const r = spawnSync('bash', [join(root, 'scripts/build.sh')], { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`scripts/build.sh failed (exit ${r.status}); see its output above`);
}

/**
 * What git sees in upstream/: changed and deleted tracked files, untracked and ignored files, and
 * the content of every change. Equal before and after a run means the run wrote nothing there;
 * a write inside an untracked or ignored folder that was already there is not seen (git lists such a
 * folder as one entry). On a clean checkout upstream/ has none.
 */
export function upstreamState(root) {
  return (
    git(root, ['status', '--porcelain=v1', '--ignored', '--', 'upstream']) +
    createHash('sha256')
      .update(git(root, ['diff', 'HEAD', '--', 'upstream']))
      .digest('hex')
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, root] = process.argv.slice(2);
  if (command !== 'sync' || !root) {
    console.error('usage: node scripts/lib/upstream-copy.mjs sync <repoRoot>');
    process.exit(2);
  }
  try {
    syncRunCopy({ root: resolve(root) });
  } catch (err) {
    console.error(`[build] ERROR: ${err.message}`);
    process.exit(1);
  }
}
