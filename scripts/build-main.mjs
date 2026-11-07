// Compiles the main process into dist/main for one build flavour (docs/test-build.md).
//   node scripts/build-main.mjs [--flavour release|test]   (default release, or ASKFILES_FLAVOUR)
// release: tsconfig.json, which leaves out src/main/test-record, so the app has no logging code.
// test: tsconfig.test-build.json, plus the test UI pages (src/renderer/test-record) copied to
// dist/main/test-record/ui, from where the test build serves them. dist/main is removed first
// either way, so a release build never picks up what an earlier test build compiled.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const FLAVOURS = ['release', 'test'];

export function parseFlavour(argv, env) {
  const i = argv.indexOf('--flavour');
  const value = i >= 0 ? argv[i + 1] : env.ASKFILES_FLAVOUR || 'release';
  if (!FLAVOURS.includes(value)) throw new Error(`flavour must be release or test, not ${value}`);
  return value;
}

/** Copies the test UI pages (not their tests) into outDir. */
export function copyTestUi(srcDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const name of fs.readdirSync(srcDir)) {
    if (name.endsWith('.test.js') || !/\.(js|css)$/.test(name)) continue;
    fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));
    copied.push(name);
  }
  return copied;
}

export function buildMain(flavour, { root = ROOT, log = console.log } = {}) {
  const outDir = path.join(root, 'dist', 'main');
  fs.rmSync(outDir, { recursive: true, force: true });
  const project = flavour === 'test' ? 'tsconfig.test-build.json' : 'tsconfig.json';
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(root, project)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tsc -p ${project} failed`);
  if (flavour === 'test') {
    const copied = copyTestUi(
      path.join(root, 'src', 'renderer', 'test-record'),
      path.join(outDir, 'test-record', 'ui'),
    );
    log(`[build-main] test build: dist/main with src/main/test-record and the test UI (${copied.join(', ')})`);
  } else {
    log('[build-main] release build: dist/main without the test record');
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'build-main.mjs') {
  try {
    buildMain(parseFlavour(process.argv.slice(2), process.env));
  } catch (e) {
    console.error(`[build-main] ${e.message}`);
    process.exit(1);
  }
}
