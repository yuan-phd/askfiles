// Prints every Mach-O file (thin or fat) under a directory, NUL-separated, for scripts/sign-adhoc.sh.
// Reads 20 bytes per file in one process instead of running file(1) once per file, which took
// 14 minutes over the roughly 90 000 files of Contents/Resources on the CI runner.
// Usage: node scripts/lib/macho-files.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { binaryKind } from '../prune.mjs';

export function machoFiles(dir) {
  const out = [];
  const buf = Buffer.alloc(20);
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const fd = fs.openSync(abs, 'r');
        const n = fs.readSync(fd, buf, 0, 20, 0);
        fs.closeSync(fd);
        const kind = binaryKind(buf.subarray(0, n));
        if (kind && kind.format.startsWith('macho')) out.push(abs);
      }
    }
  };
  walk(dir);
  return out.sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/lib/macho-files.mjs <dir>');
    process.exit(2);
  }
  for (const f of machoFiles(path.resolve(dir))) process.stdout.write(`${f}\0`);
}
