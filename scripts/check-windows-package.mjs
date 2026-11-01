// Checks the unpacked Windows app (release/win-unpacked) before the installer ships, on the Windows
// runner (.github/workflows/windows.yml). Prints a Markdown report for the job summary.
//   1. Native modules: each one AskFiles reaches has a win32-x64 binary, and it loads under the
//      packaged AskFiles.exe run as Node (ELECTRON_RUN_AS_NODE), the way server and collector run.
//   2. Every PE file under resources is x64, or a 32-bit x86 executable (WOW64 runs those); a DLL of
//      another machine would fail to load.
//   3. Path length: the longest path once installed under a long user name stays below MAX_PATH (260),
//      which installers and Explorer still enforce.
// Usage: node scripts/check-windows-package.mjs [win-unpacked-dir]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { binaryKind, HEADER_BYTES } from './prune.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What each native module needs on win32-x64: the binary file, relative to resources, and what to
 * require to load it. `optional` marks a module scripts/prune.mjs removes as unused, reported only.
 */
export const NATIVE_MODULES = [
  {
    name: '@lancedb/lancedb 0.15.0 (vector store)',
    tree: 'server',
    binary: 'server/node_modules/@lancedb/lancedb-win32-x64-msvc/lancedb.win32-x64-msvc.node',
    load: '@lancedb/lancedb',
  },
  {
    name: 'onnxruntime-node 1.14.0 (server, reranker)',
    tree: 'server',
    binary: 'server/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
    load: 'onnxruntime-node',
  },
  {
    name: 'onnxruntime-node 1.14.0 (collector)',
    tree: 'collector',
    binary: 'collector/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
    load: 'onnxruntime-node',
  },
  {
    name: 'sharp 0.33.5 (collector, OCR images)',
    tree: 'collector',
    binary: 'collector/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
    load: 'sharp',
  },
  {
    name: 'sharp 0.32.6 (server, via @xenova/transformers)',
    tree: 'server',
    binary: 'server/node_modules/sharp/build/Release/sharp-win32-x64.node',
    load: 'sharp',
  },
  {
    name: 'sharp 0.32.6 (collector, nested in @xenova/transformers, Whisper only)',
    tree: 'collector',
    binary: 'collector/node_modules/@xenova/transformers/node_modules/sharp/build/Release/sharp-win32-x64.node',
    load: '@xenova/transformers/node_modules/sharp',
    optional: 'no nested copy in this install',
  },
  {
    name: 'Prisma query engine',
    tree: 'server',
    binary: 'server/node_modules/.prisma/client/query_engine-windows.dll.node',
    load: './node_modules/.prisma/client/query_engine-windows.dll.node',
  },
  {
    name: 'Prisma schema engine (prisma migrate deploy)',
    tree: 'server',
    binary: 'server/node_modules/@prisma/engines/schema-engine-windows.exe',
    run: ['--version'],
  },
  {
    name: 'ripgrep (@vscode/ripgrep)',
    tree: 'server',
    binary: 'server/node_modules/@vscode/ripgrep/bin/rg.exe',
    run: ['--version'],
  },
  {
    name: 'canvas 3.2.1 (server, chart export)',
    tree: 'server',
    binary: 'server/node_modules/canvas/build/Release/canvas.node',
    load: 'canvas',
    optional: 'removed by scripts/prune.mjs as unused (chartjs-node-canvas export only)',
  },
  {
    name: '@napi-rs/canvas (shell, PDF page images)',
    tree: 'shell',
    binary: 'app.asar.unpacked/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
    load: '@napi-rs/canvas',
  },
  {
    name: 'Ollama',
    tree: 'ollama',
    binary: 'ollama/ollama.exe',
    run: ['--version'],
  },
];

/** A user name of 20 characters, the longest Windows lets a local account have. */
export const INSTALL_PREFIX = 'C:\\Users\\' + 'u'.repeat(20) + '\\AppData\\Local\\Programs\\AskFiles\\';
export const MAX_PATH = 260;

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    return buf.subarray(0, fs.readSync(fd, buf, 0, HEADER_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir, visit, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}\\${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), visit, r);
    else if (e.isFile()) visit(path.join(dir, e.name), r);
  }
}

/** PE files whose machine a 64-bit Windows process cannot use. */
export function foreignPeFiles(appDir) {
  const bad = [];
  walk(path.join(appDir, 'resources'), (abs, rel) => {
    if (!/\.(node|dll|exe)$/i.test(rel)) return;
    const k = binaryKind(readHeader(abs));
    if (!k || k.format !== 'pe') bad.push({ rel, why: k ? k.format : 'not a binary' });
    else if (k.machine !== undefined && k.machine !== 0x8664 && !(k.machine === 0x14c && !k.dll))
      bad.push({ rel, why: `PE machine 0x${k.machine.toString(16)}${k.dll ? ' DLL' : ''}` });
  });
  return bad;
}

/** The longest installed paths: INSTALL_PREFIX plus the path inside the app folder. */
export function longestPaths(appDir, n = 5) {
  const rels = [];
  walk(appDir, (_, rel) => rels.push(rel));
  return rels
    .map((rel) => ({ rel, length: INSTALL_PREFIX.length + rel.length }))
    .sort((a, b) => b.length - a.length)
    .slice(0, n);
}

function treeDir(res, tree) {
  if (tree === 'shell') return path.join(res, 'app.asar');
  return path.join(res, tree);
}

function loadUnderElectron(exe, res, mod) {
  // Runs in the packaged binary as Node; asar paths resolve there as they do for the shell.
  const dir = treeDir(res, mod.tree);
  const script = `
    const { createRequire } = require('module');
    const req = createRequire(${JSON.stringify(path.join(dir, 'package.json'))});
    const target = ${JSON.stringify(mod.load)};
    const m = req(target.startsWith('.') ? require('path').join(${JSON.stringify(dir)}, target) : target);
    process.stdout.write('loaded ' + typeof m);
  `;
  const r = spawnSync(exe, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const out = (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' ').slice(0, 300);
  return { ok: r.status === 0 && r.stdout.includes('loaded'), detail: r.error ? r.error.message : out };
}

function runBinary(file, args) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const out = (r.stdout + r.stderr).trim().split('\n')[0] ?? '';
  return { ok: r.status === 0, detail: r.error ? r.error.message : out.slice(0, 200) };
}

export function checkPackage(appDir) {
  const res = path.join(appDir, 'resources');
  const exe = path.join(appDir, 'AskFiles.exe');
  const rows = [];
  let failed = false;
  for (const mod of NATIVE_MODULES) {
    const file = path.join(res, ...mod.binary.split('/'));
    const present = fs.existsSync(file);
    let status;
    let detail;
    if (!present && mod.optional) {
      status = 'not shipped';
      detail = mod.optional;
    } else if (!present) {
      status = 'MISSING';
      detail = `no ${mod.binary}`;
      failed = true;
    } else {
      const r = mod.run ? runBinary(file, mod.run) : loadUnderElectron(exe, res, mod);
      status = r.ok ? 'ok' : 'FAILS TO LOAD';
      detail = r.detail;
      if (!r.ok) failed = true;
    }
    rows.push({ name: mod.name, binary: mod.binary, status, detail });
  }
  const foreign = foreignPeFiles(appDir);
  if (foreign.length) failed = true;
  const longest = longestPaths(appDir);
  if (longest[0] && longest[0].length >= MAX_PATH) failed = true;
  return { rows, foreign, longest, failed };
}

export function report({ rows, foreign, longest, failed }) {
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [
    '## Windows package check',
    '',
    '| Native module | win32-x64 binary | Status | Detail |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of rows) lines.push(`| ${cell(r.name)} | ${cell(r.binary)} | ${r.status} | ${cell(r.detail)} |`);
  lines.push(
    '',
    foreign.length
      ? `PE files a 64-bit process cannot use: ${foreign.length}`
      : 'Every PE file under resources is x64 or a 32-bit executable.',
  );
  for (const f of foreign.slice(0, 20)) lines.push(`- ${f.rel}: ${f.why}`);
  lines.push('', `Longest installed paths under ${INSTALL_PREFIX} (limit ${MAX_PATH - 1} characters):`, '');
  for (const l of longest) lines.push(`- ${l.length}: ${l.rel}`);
  lines.push('', failed ? 'Result: FAILED' : 'Result: ok');
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (os.platform() !== 'win32') {
    console.error('[check-windows-package] Windows only: it runs the packaged AskFiles.exe');
    process.exit(2);
  }
  const appDir = path.resolve(process.argv[2] ?? path.join(ROOT, 'release', 'win-unpacked'));
  const result = checkPackage(appDir);
  console.log(report(result));
  process.exit(result.failed ? 1 : 0);
}
