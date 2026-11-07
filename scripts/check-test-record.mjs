// Checks a packaged app for the test build's logging module (docs/test-build.md).
//   node scripts/check-test-record.mjs <resources-dir> [--expect absent|present]
// <resources-dir> holds app.asar: AskFiles.app/Contents/Resources on the Mac, win-unpacked/resources
// on Windows. absent (the default, for the release build) fails when any file of
// src/main/test-record or src/renderer/test-record is packaged, or when any packaged file holds the
// module's marker or its IPC channel prefix. present (for the test build) fails when none is found,
// which shows the check would see the module. Reads app.asar itself (its format is a JSON header in
// front of the file bytes), so it needs no package.
import fs from 'node:fs';
import path from 'node:path';

/** Strings only the test record's files contain (src/main/test-record/record.ts MODULE_MARKER). */
export const MARKERS = ['askfiles-test-record-module', 'askfiles-test:'];
/** Packaged paths of the logging module: the compiled main part and the test UI pages. */
const MODULE_PATH = /(^|\/)(dist\/main|src\/renderer)\/test-record(\/|$)/;
const TEXT_FILE = /\.(c?js|mjs|json|html|css|txt|map)$/i;
const MAX_SCAN = 32 * 1024 * 1024;

/** Every file in an asar archive: { path, read() } with the path relative to the archive root. */
export function asarFiles(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(8);
    fs.readSync(fd, prefix, 0, 8, 0);
    const headerSize = prefix.readUInt32LE(4);
    const pickle = Buffer.alloc(headerSize);
    fs.readSync(fd, pickle, 0, headerSize, 8);
    const length = pickle.readUInt32LE(4);
    const header = JSON.parse(pickle.subarray(8, 8 + length).toString('utf8'));
    const base = 8 + headerSize;
    const out = [];
    const walk = (node, prefixPath) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const rel = prefixPath ? `${prefixPath}/${name}` : name;
        if (entry.files) walk(entry, rel);
        else if (entry.link) continue;
        else
          out.push({
            path: rel,
            size: entry.size,
            unpacked: !!entry.unpacked,
            offset: entry.unpacked ? null : Number(entry.offset),
          });
      }
    };
    walk(header, '');
    return out.map((f) => ({
      path: f.path,
      size: f.size,
      read: () => {
        if (f.unpacked) return fs.readFileSync(path.join(`${file}.unpacked`, ...f.path.split('/')));
        const fd2 = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(f.size);
          fs.readSync(fd2, buf, 0, f.size, base + f.offset);
          return buf;
        } finally {
          fs.closeSync(fd2);
        }
      },
    }));
  } finally {
    fs.closeSync(fd);
  }
}

/** Every file under a plain folder, in the same shape as asarFiles. */
function folderFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.push({ path: r, size: fs.statSync(p).size, read: () => fs.readFileSync(p) });
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Findings in a resources folder: module files by path and marker hits by content, in app.asar
 * (or, for an unpacked app folder, resources/app) and app.asar.unpacked.
 */
export function findTestRecord(resourcesDir) {
  const asar = path.join(resourcesDir, 'app.asar');
  const plain = path.join(resourcesDir, 'app');
  let files;
  let source;
  if (fs.existsSync(asar)) {
    files = asarFiles(asar);
    source = 'app.asar';
  } else if (fs.existsSync(plain)) {
    files = folderFiles(plain);
    source = 'app';
  } else throw new Error(`no app.asar or app folder in ${resourcesDir}`);
  const findings = [];
  let scanned = 0;
  for (const f of files) {
    if (MODULE_PATH.test(f.path)) findings.push(`${source}/${f.path}: a file of the test record`);
    if (!TEXT_FILE.test(f.path) || f.size > MAX_SCAN) continue;
    scanned++;
    const text = f.read().toString('utf8');
    for (const m of MARKERS) if (text.includes(m)) findings.push(`${source}/${f.path}: contains ${m}`);
  }
  return { source, files: files.length, scanned, findings };
}

function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'));
  const i = argv.indexOf('--expect');
  const expect = i >= 0 ? argv[i + 1] : 'absent';
  if (!dir || !['absent', 'present'].includes(expect)) {
    console.error('usage: node scripts/check-test-record.mjs <resources-dir> [--expect absent|present]');
    return 2;
  }
  const r = findTestRecord(dir);
  console.log(
    `[check-test-record] ${r.source}: ${r.files} files, ${r.scanned} text files read, ${r.findings.length} findings`,
  );
  for (const f of r.findings.slice(0, 50)) console.log(`[check-test-record]   ${f}`);
  if (expect === 'absent' && r.findings.length) {
    console.error('[check-test-record] FAIL: the release build contains the test record (docs/test-build.md)');
    return 1;
  }
  if (expect === 'present' && !r.findings.length) {
    console.error('[check-test-record] FAIL: the test build has no test record; the check would not see it');
    return 1;
  }
  console.log(`[check-test-record] ok: test record ${expect}`);
  return 0;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-test-record.mjs') {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`[check-test-record] ${e.message}`);
    process.exitCode = 2;
  }
}
