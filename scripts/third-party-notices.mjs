#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES: every package the app bundles with its version and license, and
// each distinct license text once. Packages are the production dependency closures of the shell
// (package.json dependencies, packed into app.asar), of upstream server and collector (shipped
// in Contents/Resources) and of upstream frontend (built into server/public), resolved the way
// Node resolves them from the installed node_modules folders. Dev dependencies are never walked.
//
// Usage: node scripts/third-party-notices.mjs [out-file]   (default THIRD-PARTY-NOTICES)
// Run it after npm ci and scripts/install_pkgs.sh or scripts/build.sh. Platform packages follow
// the machine it runs on: on Linux the list has linux builds where the Mac app has darwin ones.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMPONENTS = [
  { label: 'AskFiles shell (app.asar)', dir: ROOT },
  { label: 'upstream server', dir: path.join(ROOT, 'upstream', 'server') },
  { label: 'upstream collector', dir: path.join(ROOT, 'upstream', 'collector') },
  { label: 'upstream frontend (server/public)', dir: path.join(ROOT, 'upstream', 'frontend') },
];

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-_.].*)?$/i;

/**
 * Standard license texts from SPDX license-list-data v3.27.0, one file per id, for packages that
 * name a license but ship no license file. LGPL-3.0.txt is the SPDX LGPL-3.0-only text, which
 * carries the GPL-3.0 text it builds on, as LGPL section 4 requires both to accompany the work.
 */
export const LICENSE_TEXTS_DIR = path.join(ROOT, 'scripts', 'license-texts');

/** License names seen in package.json fields, mapped to the file in LICENSE_TEXTS_DIR. */
const LICENSE_ALIASES = {
  mit: 'MIT',
  'mit/x11': 'MIT',
  x11: 'MIT',
  'apache-2.0': 'Apache-2.0',
  'apache 2.0': 'Apache-2.0',
  apache2: 'Apache-2.0',
  'apache license 2.0': 'Apache-2.0',
  'bsd-2-clause': 'BSD-2-Clause',
  'bsd-3-clause': 'BSD-3-Clause',
  isc: 'ISC',
  'lgpl-3.0': 'LGPL-3.0',
  'lgpl-3.0-only': 'LGPL-3.0',
  'lgpl-3.0-or-later': 'LGPL-3.0',
  'lgpl-3.0+': 'LGPL-3.0',
  'mpl-2.0': 'MPL-2.0',
  'cc0-1.0': 'CC0-1.0',
};

/**
 * Standard text ids for a license field such as (MIT OR Apache-2.0) or MIT AND ISC. Every id is
 * kept, OR included, so the reader has the text of whichever one applies. unresolved holds the
 * names without a bundled text, UNKNOWN among them.
 */
export function standardLicenseIds(license) {
  const ids = new Set();
  const unresolved = [];
  for (const raw of license.split(/\s+(?:OR|AND)\s+|[()]/)) {
    const name = raw.trim();
    if (!name) continue;
    const id = LICENSE_ALIASES[name.toLowerCase()];
    if (id) ids.add(id);
    else unresolved.push(name);
  }
  return { ids: [...ids], unresolved };
}

/** id -> text of every file in LICENSE_TEXTS_DIR. */
export function loadStandardTexts(dir = LICENSE_TEXTS_DIR) {
  const out = new Map();
  for (const f of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort()) {
    out.set(f.slice(0, -4), fs.readFileSync(path.join(dir, f), 'utf8').trim());
  }
  return out;
}

/** Heading of a standard text in the notices file; the test looks for it. */
export function standardTextHeading(id) {
  return `=== Standard license text: ${id} ===`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Directory of package name as required from fromDir, searching node_modules upwards to stopDir. */
export function resolvePackage(name, fromDir, stopDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === stopDir) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && !Array.isArray(l)) return l.type ?? 'UNKNOWN';
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
  return 'UNKNOWN';
}

function licenseText(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort();
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n');
}

/** Production closure of the package at rootDir: Map name@version -> entry. */
export function collect(rootDir) {
  const out = new Map();
  const missing = [];
  const seenDirs = new Set();
  const root = readJson(path.join(rootDir, 'package.json'));
  const queue = Object.keys({ ...root.dependencies, ...root.optionalDependencies }).map((name) => ({
    name,
    from: rootDir,
    optional: !!root.optionalDependencies?.[name],
  }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const dir = resolvePackage(name, from, rootDir);
    if (!dir) {
      if (!optional) missing.push(name);
      continue;
    }
    const real = fs.realpathSync(dir);
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    const pkg = readJson(path.join(dir, 'package.json'));
    const key = `${pkg.name ?? name}@${pkg.version ?? '0.0.0'}`;
    if (!out.has(key)) {
      out.set(key, {
        name: pkg.name ?? name,
        version: pkg.version ?? '',
        license: licenseOf(pkg),
        text: licenseText(dir),
      });
    }
    for (const [deps, opt] of [
      [pkg.dependencies, false],
      [pkg.optionalDependencies, true],
      [pkg.peerDependencies, true],
    ]) {
      for (const dep of Object.keys(deps ?? {}))
        queue.push({ name: dep, from: dir, optional: opt || !!pkg.optionalDependencies?.[dep] });
    }
  }
  return { packages: out, missing: [...new Set(missing)].sort() };
}

const HEADER = `THIRD-PARTY NOTICES

AskFiles includes the software listed below. Each part is distributed under its own license,
reproduced in the License texts section. Generated by scripts/third-party-notices.mjs.

Components without an npm package

- AnythingLLM by Mintplex Labs Inc. (server, collector and frontend), MIT License. Full text below
  under "AnythingLLM". Copyright and license notices inside the bundled folders are kept as shipped.
- Ollama, MIT License. The Ollama release bundled in Contents/Resources/ollama ships its own
  license and notice files for the libraries it includes; they are kept there unchanged.
- Electron, MIT License, with Chromium and Node.js. Their licenses ship in the app bundle as
  LICENSE.electron.txt and LICENSES.chromium.html (Contents/Resources).
- Tesseract language data (eng, chi_sim, 4.0.0_best_int) from tesseract-ocr/tessdata_best,
  Apache License 2.0, via the npm packages @tesseract.js-data/eng and @tesseract.js-data/chi_sim.
- Language models are not bundled. They are downloaded on first run through Ollama under their own
  licenses: the Qwen3 chat models (Apache License 2.0) and the bge-m3 embedding model (MIT License).
`;

export function render(components, upstreamLicense, standardTexts = loadStandardTexts()) {
  const all = new Map();
  for (const c of components) {
    for (const [key, p] of c.packages) {
      const e = all.get(key) ?? { ...p, components: [] };
      e.components.push(c.label);
      all.set(key, e);
    }
  }
  const entries = [...all.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = [HEADER, `Packages (${entries.length})`, ''];
  for (const [key, e] of entries) lines.push(`- ${key}  ${e.license}  [${e.components.join('; ')}]`);
  for (const c of components) {
    if (c.missing.length) lines.push('', `Not installed when generated, for ${c.label}: ${c.missing.join(', ')}`);
  }
  lines.push('', '', 'License texts', '', '=== AnythingLLM ===', '', upstreamLicense.trim(), '');

  const byText = new Map();
  const standardUsers = new Map();
  const unnamed = [];
  for (const [key, e] of entries) {
    if (!e.text) {
      const { ids, unresolved } = standardLicenseIds(e.license);
      for (const id of ids.filter((i) => standardTexts.has(i))) {
        standardUsers.set(id, [...(standardUsers.get(id) ?? []), key]);
      }
      const missing = [...unresolved, ...ids.filter((i) => !standardTexts.has(i))];
      if (missing.length) unnamed.push(`${key} (${e.license})`);
      continue;
    }
    const h = createHash('sha256').update(e.text.replace(/\s+/g, ' ')).digest('hex');
    const g = byText.get(h) ?? { text: e.text, users: [] };
    g.users.push(key);
    byText.set(h, g);
  }
  for (const g of byText.values()) lines.push(`=== Used by: ${g.users.join(', ')} ===`, '', g.text, '');
  for (const id of [...standardUsers.keys()].sort()) {
    lines.push(
      standardTextHeading(id),
      '',
      `These packages ship no license file and name ${id} in their package.json: ${standardUsers.get(id).join(', ')}.`,
      'The standard text follows; their copyright holders are the authors named in each package.',
      '',
      standardTexts.get(id),
      '',
    );
  }
  if (unnamed.length) {
    lines.push(
      '=== Packages that ship no license file and name no license with a standard text here ===',
      '',
      ...unnamed.map((w) => `- ${w}`),
      '',
    );
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outFile = path.resolve(process.argv[2] ?? path.join(ROOT, 'THIRD-PARTY-NOTICES'));
  const components = COMPONENTS.filter((c) => fs.existsSync(path.join(c.dir, 'node_modules'))).map((c) => ({
    label: c.label,
    ...collect(c.dir),
  }));
  for (const c of COMPONENTS) {
    if (!components.some((x) => x.label === c.label)) console.warn(`[notices] ${c.label}: no node_modules, skipped`);
  }
  const text = render(components, fs.readFileSync(path.join(ROOT, 'upstream', 'LICENSE'), 'utf8'));
  fs.writeFileSync(outFile, text);
  const count = new Set(components.flatMap((c) => [...c.packages.keys()])).size;
  console.log(
    `[notices] wrote ${path.relative(ROOT, outFile)}: ${count} packages, ${(text.length / 1024).toFixed(0)} KB`,
  );
}
