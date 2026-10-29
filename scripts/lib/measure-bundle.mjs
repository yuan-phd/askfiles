// Measures the packaged server and collector dependency folders: totals, the largest package
// directories, packages installed at more than one path, and development-only files still shipped.
// Usage: node scripts/lib/measure-bundle.mjs <resourcesDir> [--top <n>]
// <resourcesDir> holds server/node_modules and collector/node_modules (Contents/Resources on the Mac,
// release/linux-unpacked/resources on Linux). Prints Markdown on stdout.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TREES = ['server/node_modules', 'collector/node_modules'];

// Development-only content: the categories scripts/prune.mjs is allowed to remove.
const DEV_DIRS = new Set(['test', 'tests', '__tests__', 'example', 'examples', 'docs', 'doc', '.github']);
export function devKind(name, isDir) {
  if (isDir) return DEV_DIRS.has(name) ? 'test, example and doc folders' : null;
  if (name.endsWith('.map')) return 'source maps';
  if (/\.d\.[cm]?ts$/.test(name)) return 'typings';
  if (/^(readme|changelog|history)(\.[a-z]+)?$/i.test(name)) return 'readme and changelog';
  return null;
}

/**
 * Walks one node_modules tree. Every package directory (a child of node_modules, or of an @scope
 * folder) gets its own size: its files without the nested node_modules, which are counted as
 * packages of their own, so nothing is counted twice.
 */
export function walkTree(nodeModulesDir) {
  const packages = [];
  const dev = new Map();
  let total = 0;
  let files = 0;

  function addDev(kind, bytes) {
    dev.set(kind, (dev.get(kind) ?? 0) + bytes);
  }

  // Returns the byte size of `dir` without nested node_modules; registers nested packages.
  function sizeOf(dir, devCategory) {
    let bytes = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          scanNodeModules(abs);
          continue;
        }
        const kind = devCategory ?? devKind(entry.name, true);
        const sub = sizeOf(abs, kind);
        bytes += sub;
        if (kind && !devCategory) addDev(kind, sub);
      } else if (entry.isFile()) {
        const size = lstatSync(abs).size;
        bytes += size;
        files += 1;
        if (!devCategory) {
          const kind = devKind(entry.name, false);
          if (kind) addDev(kind, size);
        }
      }
    }
    return bytes;
  }

  function addPackage(dir) {
    const bytes = sizeOf(dir, null);
    total += bytes;
    packages.push({ path: dir, name: packageName(dir), bytes });
  }

  function scanNodeModules(nm) {
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = join(nm, entry.name);
      if (entry.name.startsWith('@')) {
        for (const sub of readdirSync(abs, { withFileTypes: true })) {
          if (sub.isDirectory()) addPackage(join(abs, sub.name));
        }
      } else if (entry.name === '.bin') {
        continue;
      } else {
        addPackage(abs);
      }
    }
  }

  scanNodeModules(nodeModulesDir);
  return { packages, dev, total, files };
}

function packageName(dir) {
  try {
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name) return name;
  } catch {
    // Folders such as .prisma have no package.json; fall back to the folder name.
  }
  const parts = dir.split(/[\\/]/);
  const last = parts.at(-1);
  const parent = parts.at(-2);
  return parent?.startsWith('@') ? `${parent}/${last}` : last;
}

/** Package names found at more than one path, with every copy's size. */
export function findDuplicates(packages) {
  const byName = new Map();
  for (const p of packages) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  return [...byName.entries()]
    .filter(([, copies]) => copies.length > 1)
    .map(([name, copies]) => ({ name, copies, bytes: copies.reduce((s, c) => s + c.bytes, 0) }))
    .sort((a, b) => b.bytes - a.bytes);
}

export function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function measure(resourcesDir, top = 40) {
  const trees = TREES.map((t) => ({ tree: t, ...walkTree(join(resourcesDir, t)) }));
  const all = trees.flatMap((t) => t.packages);
  const lines = [];
  lines.push('| Tree | Size | Files | Package directories |', '| --- | --- | --- | --- |');
  for (const t of trees) {
    lines.push(`| ${t.tree} | ${formatSize(t.total)} | ${t.files} | ${t.packages.length} |`);
  }
  const total = trees.reduce((s, t) => s + t.total, 0);
  const files = trees.reduce((s, t) => s + t.files, 0);
  lines.push(`| both | ${formatSize(total)} | ${files} | ${all.length} |`, '');

  lines.push(`### ${top} largest package directories`, '');
  lines.push('Own size: files of the package without its nested node_modules, which are listed separately.', '');
  lines.push('| Size | Path |', '| --- | --- |');
  for (const p of [...all].sort((a, b) => b.bytes - a.bytes).slice(0, top)) {
    lines.push(`| ${formatSize(p.bytes)} | ${relative(resourcesDir, p.path)} |`);
  }
  lines.push('');

  // Within one tree only: server and collector are separate installs and cannot share a copy.
  lines.push('### Packages installed at more than one path in the same tree', '');
  for (const t of trees) {
    const dups = findDuplicates(t.packages);
    const extra = dups.reduce((s, d) => s + d.bytes - Math.max(...d.copies.map((c) => c.bytes)), 0);
    lines.push(`${t.tree}: ${dups.length} names; ${formatSize(extra)} beyond the largest copy of each. Largest 10:`, '');
    lines.push('| Package | Copies | Size of all copies |', '| --- | --- | --- |');
    for (const d of dups.slice(0, 10)) lines.push(`| ${d.name} | ${d.copies.length} | ${formatSize(d.bytes)} |`);
    lines.push('');
  }

  lines.push('### Development-only files still shipped', '');
  lines.push('| Kind | Size |', '| --- | --- |');
  const devTotals = new Map();
  for (const t of trees) for (const [k, v] of t.dev) devTotals.set(k, (devTotals.get(k) ?? 0) + v);
  for (const [k, v] of [...devTotals].sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${formatSize(v)} |`);
  return { markdown: lines.join('\n') + '\n', total, files };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const topIndex = args.indexOf('--top');
  const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 40;
  const dir = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : undefined;
  if (!dir || !Number.isInteger(top) || top < 1) {
    console.error('usage: node scripts/lib/measure-bundle.mjs <resourcesDir> [--top <n>]');
    process.exit(2);
  }
  try {
    process.stdout.write(measure(dir, top).markdown);
  } catch (err) {
    console.error(`[measure-bundle] ERROR: ${err.message}`);
    process.exit(1);
  }
}
