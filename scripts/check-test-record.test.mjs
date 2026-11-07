// The release build has no logging code (docs/test-build.md): the release program does not compile
// src/main/test-record, the build script leaves it out, every file of the module carries a marker
// and no release source does, and the CI check finds the module in a packaged app.asar and fails,
// and passes on one without it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { asarFiles, findTestRecord, MARKERS } from './check-test-record.mjs';
import { copyTestUi, parseFlavour } from './build-main.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
// @electron/asar comes with electron-builder; the test only uses it to make archives to read.
const asar = require('@electron/asar');

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-check-'));
  dirs.push(d);
  return d;
}

function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

async function packaged(files) {
  const app = tmp();
  write(app, files);
  const resources = tmp();
  await asar.createPackage(app, path.join(resources, 'app.asar'));
  return resources;
}

const RELEASE = {
  'package.json': '{"name":"askfiles"}',
  'dist/main/index.js': 'require("./test-build.js");',
  'dist/main/test-build.js': 'const p = path.join(dir, "test-record", "index.js");',
  'src/renderer/ask/ask.js': 'window.dispatchEvent(new CustomEvent("askfiles:source-card"));',
};

function run(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-test-record.mjs'), ...args], {
    encoding: 'utf8',
  });
}

describe('check-test-record on a packaged app', () => {
  it('reads every file of an app.asar', async () => {
    const resources = await packaged({ 'a.txt': 'alpha', 'dir/b.js': 'beta' });
    const files = asarFiles(path.join(resources, 'app.asar'));
    expect(Object.fromEntries(files.map((f) => [f.path, f.read().toString()]))).toEqual({
      'a.txt': 'alpha',
      'dir/b.js': 'beta',
    });
  });

  it('passes a release app and fails one with the module, by path and by content', async () => {
    const release = await packaged(RELEASE);
    expect(findTestRecord(release).findings).toEqual([]);
    const ok = run([release]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('ok: test record absent');

    const withModule = await packaged({
      ...RELEASE,
      'dist/main/test-record/index.js': '// askfiles-test-record-module',
    });
    expect(findTestRecord(withModule).findings).toEqual([
      'app.asar/dist/main/test-record/index.js: a file of the test record',
      'app.asar/dist/main/test-record/index.js: contains askfiles-test-record-module',
    ]);
    const bad = run([withModule]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('FAIL: the release build contains the test record');

    // Copied somewhere else under another name, the code is still found by its channels.
    const hidden = await packaged({ ...RELEASE, 'dist/main/x.js': 'ipc.invoke("askfiles-test:export")' });
    expect(findTestRecord(hidden).findings).toEqual(['app.asar/dist/main/x.js: contains askfiles-test:']);
    expect(run([hidden]).status).toBe(1);
    const ui = await packaged({ ...RELEASE, 'src/renderer/test-record/ui.js': '' });
    expect(run([ui]).status).toBe(1);
  });

  it('with --expect present, fails a release app and passes a test build', async () => {
    expect(run([await packaged(RELEASE), '--expect', 'present']).status).toBe(1);
    const test = await packaged({ ...RELEASE, 'dist/main/test-record/ui/ui.js': '// askfiles-test-record-module' });
    expect(run([test, '--expect', 'present']).status).toBe(0);
  });

  it('refuses a folder without an app', () => {
    expect(run([tmp()]).status).toBe(2);
    expect(run([]).status).toBe(2);
  });
});

describe('the release build compiles no logging code', () => {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const listFiles = (project) =>
    spawnSync(process.execPath, [tsc, '-p', path.join(ROOT, project), '--listFilesOnly'], { encoding: 'utf8' })
      .stdout.split('\n')
      .map((l) => path.relative(ROOT, l.trim()).split(path.sep).join('/'))
      .filter((l) => l.startsWith('src/'));

  it('leaves src/main/test-record out of the release program and keeps it in the test one', () => {
    const release = listFiles('tsconfig.json');
    const test = listFiles('tsconfig.test-build.json');
    expect(release.length).toBeGreaterThan(50);
    expect(release.filter((f) => f.includes('test-record'))).toEqual([]);
    expect(test.filter((f) => f.startsWith('src/main/test-record/')).sort()).toEqual([
      'src/main/test-record/index.ts',
      'src/main/test-record/preload.ts',
      'src/main/test-record/record.ts',
    ]);
  });

  it('marks every file of the module, and no release source carries a marker', () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    const sources = [...walk(path.join(ROOT, 'src', 'main')), ...walk(path.join(ROOT, 'src', 'renderer'))].filter(
      (f) => /\.(ts|js|html|css)$/.test(f) && !/\.test\.(ts|js)$/.test(f),
    );
    const inModule = (f) => f.split(path.sep).includes('test-record');
    const marked = (f) => MARKERS.some((m) => fs.readFileSync(f, 'utf8').includes(m));
    const moduleFiles = sources.filter(inModule);
    expect(moduleFiles.length).toBeGreaterThanOrEqual(6);
    // CSS carries no code; every script of the module is found by its content alone.
    expect(moduleFiles.filter((f) => !f.endsWith('.css') && !marked(f))).toEqual([]);
    expect(sources.filter((f) => !inModule(f) && marked(f))).toEqual([]);
  });

  it('electron-builder never packages the test UI pages from src/renderer', () => {
    expect(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')).toContain(
      "- '!src/renderer/test-record/**'",
    );
  });
});

describe('build-main', () => {
  it('takes the flavour from the argument, then ASKFILES_FLAVOUR, release by default', () => {
    expect(parseFlavour([], {})).toBe('release');
    expect(parseFlavour([], { ASKFILES_FLAVOUR: 'test' })).toBe('test');
    expect(parseFlavour(['--flavour', 'release'], { ASKFILES_FLAVOUR: 'test' })).toBe('release');
    expect(() => parseFlavour(['--flavour', 'debug'], {})).toThrow(/release or test/);
  });

  it('copies the test UI pages without their tests', () => {
    const src = tmp();
    write(src, { 'ui.js': 'a', 'texts.js': 'b', 'ui.css': 'c', 'ui.test.js': 'd', 'notes.md': 'e' });
    const out = path.join(tmp(), 'ui');
    expect(copyTestUi(src, out).sort()).toEqual(['texts.js', 'ui.css', 'ui.js']);
    expect(fs.readdirSync(out).sort()).toEqual(['texts.js', 'ui.css', 'ui.js']);
  });
});
