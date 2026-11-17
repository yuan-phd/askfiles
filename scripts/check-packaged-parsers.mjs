// Parses one invented file of every supported type with the splitter inside a packaged app.asar,
// under Electron's Node, the way the packaged main process loads it. The unit tests import the
// splitter from src/ with the whole of node_modules at hand; the package leaves files out
// (electron-builder.yml), so a module the splitter loads only on first use can be missing from the
// app and nothing but this check notices (an .xls never indexed in the test build, 2026-11-17).
//
// Usage: node scripts/check-packaged-parsers.mjs [resources-dir]
//   resources-dir  holds app.asar; default "release/mac-arm64/AskFiles.app/Contents/Resources"
// Environment:
//   ELECTRON       Electron binary run as Node; default the one in node_modules/electron
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.resolve(process.argv[2] ?? path.join(ROOT, 'release/mac-arm64/AskFiles.app/Contents/Resources'));
const ELECTRON =
  process.env.ELECTRON ??
  (process.platform === 'darwin'
    ? path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : process.platform === 'win32'
      ? path.join(ROOT, 'node_modules/electron/dist/electron.exe')
      : path.join(ROOT, 'node_modules/electron/dist/electron'));
const FIXTURES = path.join(ROOT, 'test/fixtures');

// One invented file per entry of SUPPORTED_EXTENSIONS; the check fails if the list gains a type
// that has no file here.
const FILES = {
  '.pdf': path.join(FIXTURES, 'handbook.pdf'),
  '.docx': path.join(FIXTURES, 'headings.docx'),
  '.xlsx': null, // copied from the .xlsm below: the same workbook format
  '.xlsm': path.join(FIXTURES, 'budget-2026.xlsm'),
  '.xls': path.join(FIXTURES, 'budget-2026.xls'),
  '.pptx': path.join(FIXTURES, 'deck.pptx'),
  '.md': null,
  '.markdown': null,
  '.txt': null,
};

const asar = path.join(RES, 'app.asar');
if (!fs.existsSync(asar)) {
  console.error(`[check-packaged-parsers] no app.asar in ${RES}`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'askfiles-parsers-'));
try {
  const inputs = {};
  for (const [ext, src] of Object.entries(FILES)) {
    const dest = path.join(tmp, `invented${ext}`);
    if (src) fs.copyFileSync(src, dest);
    else if (ext === '.xlsx') fs.copyFileSync(FILES['.xlsm'], dest);
    else fs.writeFileSync(dest, `# Invented heading\n\nInvented text for the ${ext} check.\n`);
    inputs[ext] = dest;
  }
  // Runs inside Electron's Node: asar paths read like folders there, and module resolution and
  // package exports work as in the app's main process.
  const child = `
    const { pathToFileURL } = require('node:url');
    const [asar, inputs] = [process.argv[1], JSON.parse(process.argv[2])];
    (async () => {
      const s = await import(pathToFileURL(asar + '/dist/main/sections/index.js').href);
      const missing = s.SUPPORTED_EXTENSIONS.filter((e) => !inputs[e]);
      let failed = missing.length > 0;
      for (const e of missing) console.log('FAIL: ' + e + ' (no invented file in the check)');
      for (const e of s.SUPPORTED_EXTENSIONS.filter((e) => inputs[e])) {
        try {
          const doc = await s.parseFile(inputs[e]);
          const ok = doc.sections.length > 0;
          failed ||= !ok;
          console.log((ok ? 'ok: ' : 'FAIL: ') + e + ' (' + doc.sections.length + ' sections)');
        } catch (err) {
          failed = true;
          console.log('FAIL: ' + e + ' (' + (err && err.message) + ')');
        }
      }
      process.exit(failed ? 1 : 0);
    })().catch((err) => { console.log('FAIL: ' + (err && err.stack)); process.exit(1); });
  `;
  const r = spawnSync(ELECTRON, ['-e', child, asar, JSON.stringify(inputs)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  for (const line of `${r.stdout ?? ''}`.split('\n').filter(Boolean)) console.log(`[check-packaged-parsers] ${line}`);
  if (r.status !== 0) {
    if (r.stderr) console.error(r.stderr.trim());
    console.error(`[check-packaged-parsers] failed in ${asar}`);
    process.exit(1);
  }
  console.log(`[check-packaged-parsers] every supported type parses in ${asar}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
