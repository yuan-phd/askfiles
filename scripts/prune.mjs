// Prunes the production node_modules of upstream/server and upstream/collector after scripts/build.sh
// installed them; electron-builder then copies these folders into the app as they are. Never touches
// tracked files under upstream/. docs/bundle-report.md records what each step saves.
//
// Usage: node scripts/prune.mjs <upstreamDir> --target <darwin-arm64|linux-x64|win32-x64> [--steps a,b] [--dry-run]
// Steps, in this order by default:
//   platform  binaries the target cannot load, found by file header (ELF, PE and Mach-O, with the CPU type)
//   dev       source maps, typings, @types packages, readme and changelog files, test and example folders
//   unused    packages AskFiles never reaches (UNUSED below) and the packages only they depend on
//   providers vector database clients and model provider SDKs for providers AskFiles never selects
//             (PROVIDERS below), with the same guards as unused
//   longpaths win32-x64 only: files whose installed path would pass MAX_PATH, when they are empty
//             module stubs nothing in their package refers to (see pruneLongPaths)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGraph, relPosix } from './lib/load-graph.mjs';

export const TREES = ['server', 'collector'];
export const TARGETS = ['darwin-arm64', 'linux-x64', 'win32-x64'];
export const STEPS = ['platform', 'dev', 'unused', 'providers', 'longpaths'];

// ---- platform -------------------------------------------------------------------------------

const MACHO_THIN = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe']);
const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;
const MH_EXECUTE = 2;
const EM_X86_64 = 0x3e;
const PE_AMD64 = 0x8664;
const PE_I386 = 0x14c;
const PE_DLL = 0x2000;
/** Enough of a file for the PE header, which sits at the offset stored at 0x3c (usually below 0x200). */
export const HEADER_BYTES = 1024;

/** Reads enough of a file header to tell ELF, PE and Mach-O apart. Null for anything else. */
export function binaryKind(buf) {
  if (buf.length < 20) return null;
  const magic = buf.subarray(0, 4).toString('hex');
  if (magic === '7f454c46') {
    const little = buf[5] === 1;
    return { format: 'elf', machine: little ? buf.readUInt16LE(18) : buf.readUInt16BE(18) };
  }
  if (MACHO_THIN.has(magic)) {
    // feedface/feedfacf are big-endian headers, cefaedfe/cffaedfe little-endian.
    const little = magic.startsWith('ce') || magic.startsWith('cf');
    const read = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    return { format: 'macho', cpu: read(4), filetype: read(12) };
  }
  if (magic === 'cafebabe' || magic === 'cafebabf') {
    // Fat Mach-O and Java class files share this magic; a fat header has a small arch count where a
    // class file has its version (45 or more).
    const count = buf.readUInt32BE(4);
    return count > 0 && count < 20 ? { format: 'macho-fat' } : null;
  }
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    // Machine and characteristics from the COFF header after the PE signature; without them (a
    // short read, or a text file that starts with MZ) the file stays a PE of unknown machine.
    const at = buf.length >= 0x40 ? buf.readUInt32LE(0x3c) : -1;
    if (at > 0 && at + 24 <= buf.length && buf.subarray(at, at + 4).toString('hex') === '50450000') {
      return { format: 'pe', machine: buf.readUInt16LE(at + 4), dll: (buf.readUInt16LE(at + 22) & PE_DLL) !== 0 };
    }
    return { format: 'pe' };
  }
  return null;
}

/**
 * Whether `target` can never use this binary. Thin x86_64 Mach-O executables stay on darwin-arm64:
 * Rosetta can run an executable, but never load an x86_64 library into an arm64 process.
 */
export function foreignBinary(kind, target) {
  if (!kind) return false;
  if (target === 'darwin-arm64') {
    if (kind.format === 'elf' || kind.format === 'pe') return true;
    if (kind.format === 'macho')
      return kind.cpu !== CPU_ARM64 && !(kind.cpu === CPU_X86_64 && kind.filetype === MH_EXECUTE);
    return false;
  }
  if (target === 'linux-x64') {
    if (kind.format === 'elf') return kind.machine !== EM_X86_64;
    return true;
  }
  if (target === 'win32-x64') {
    // Like Rosetta on the Mac, WOW64 runs a 32-bit x86 executable but never loads a 32-bit DLL
    // (every .node file is a DLL) into the 64-bit process; arm64 builds are of no use either.
    if (kind.format !== 'pe') return true;
    if (kind.machine === undefined || kind.machine === PE_AMD64) return false;
    return !(kind.machine === PE_I386 && !kind.dll);
  }
  throw new Error(`unknown target ${target}`);
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function walkFiles(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, visit);
    else if (entry.isFile()) visit(abs, entry.name);
  }
}

export function prunePlatform(nodeModules, target, dryRun) {
  const removed = [];
  walkFiles(nodeModules, (file) => {
    if (fs.statSync(file).size < 20) return;
    const kind = binaryKind(readHeader(file));
    if (!foreignBinary(kind, target)) return;
    removed.push({ path: file, bytes: fs.statSync(file).size, why: kind.format });
    if (!dryRun) fs.rmSync(file);
  });
  return removed;
}

// ---- dev ------------------------------------------------------------------------------------

const DEV_FILE = [
  /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|css)\.map$/,
  /\.d\.[cm]?ts$/,
  /^(readme|changelog|history)(\.(md|markdown|txt))?$/i,
];
// Removed only directly under a package root, where they never hold code a package entry needs;
// a folder of the same name deeper down (yaml/dist/doc) can be code.
const DEV_ROOT_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'example',
  'examples',
  'docs',
  'doc',
  '.github',
  'coverage',
  'benchmark',
  'benchmarks',
]);
const CODE_FILE = /\.(js|mjs|cjs|node|wasm|json)$/;

const README = /^readme(\.(md|markdown|txt))?$/i;
const isPackageRoot = (dir) => fs.existsSync(path.join(dir, 'package.json'));
const hasLicenseFile = (dir) => fs.readdirSync(dir).some((n) => /^(licen[cs]e|copying|notice)/i.test(n));

export function isDevFile(name) {
  return DEV_FILE.some((re) => re.test(name));
}

/** Top-level folders a package's entry points refer to (main, module, browser, bin, exports). */
export function entryDirs(pkg) {
  const dirs = new Set();
  const add = (value) => {
    if (typeof value === 'string') {
      const first = value.replace(/^\.\//, '').split('/')[0];
      if (first && value.replace(/^\.\//, '').includes('/')) dirs.add(first);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) add(v);
    }
  };
  for (const field of ['main', 'module', 'browser', 'bin', 'exports']) add(pkg[field]);
  return dirs;
}

function hasCode(dir) {
  let found = false;
  walkFiles(dir, (_, name) => {
    if (/\.(js|mjs|cjs|node|wasm)$/.test(name)) found = true;
  });
  return found;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every package directory under a node_modules tree, nested ones included. */
export function packageDirs(nodeModules) {
  const out = [];
  const scan = (nm) => {
    for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const abs = path.join(nm, entry.name);
      const dirs = entry.name.startsWith('@')
        ? fs
            .readdirSync(abs, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => path.join(abs, e.name))
        : [abs];
      for (const d of dirs) {
        out.push(d);
        if (fs.existsSync(path.join(d, 'node_modules'))) scan(path.join(d, 'node_modules'));
      }
    }
  };
  scan(nodeModules);
  return out;
}

function dirSize(dir) {
  let bytes = 0;
  walkFiles(dir, (file) => {
    bytes += fs.lstatSync(file).size;
  });
  return bytes;
}

export function pruneDev(nodeModules, dryRun) {
  const removed = [];
  const remove = (p, why, bytes) => {
    removed.push({ path: p, bytes, why });
    if (!dryRun) fs.rmSync(p, { recursive: true, force: true });
  };
  for (const pkgDir of packageDirs(nodeModules)) {
    if (!fs.existsSync(pkgDir)) continue;
    const pkg = readJson(path.join(pkgDir, 'package.json')) ?? {};
    // @types packages hold only typings; nothing requires them at run time.
    if (path.basename(path.dirname(pkgDir)) === '@types' && !hasCode(pkgDir)) {
      remove(pkgDir, '@types package', dirSize(pkgDir));
      continue;
    }
    const keep = entryDirs(pkg);
    for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
      if (entry.isDirectory() && DEV_ROOT_DIRS.has(entry.name) && !keep.has(entry.name)) {
        const abs = path.join(pkgDir, entry.name);
        remove(abs, 'test, example or doc folder', dirSize(abs));
      }
    }
  }
  walkFiles(nodeModules, (file, name) => {
    if (!isDevFile(name) || CODE_FILE.test(name.replace(/\.map$/, '.x'))) return;
    // A package without a license file states its license in the readme; that notice must ship.
    if (README.test(name) && isPackageRoot(path.dirname(file)) && !hasLicenseFile(path.dirname(file))) return;
    remove(file, 'dev file', fs.statSync(file).size);
  });
  return removed;
}

// ---- unused ---------------------------------------------------------------------------------

// Packages upstream loads only on code paths AskFiles never reaches. Each entry lists every upstream
// file that requires it; any other require of a package removed with it fails the step.
// docs/bundle-report.md has the evidence.
export const UNUSED = {
  server: {
    canvas: ['utils/chats/exportChatToFile.js'],
    'chartjs-node-canvas': ['utils/telegramBot/chat/agent.js'],
    '@mintplex-labs/mdpdf': [
      'utils/chats/exportChatToFile.js',
      'utils/agents/aibitat/plugins/create-files/pdf/create-pdf-file.js',
    ],
  },
  collector: {
    // Both are JSDoc type imports; at run time langchain's PuppeteerWebBaseLoader imports puppeteer
    // lazily, for link scraping only.
    puppeteer: ['processLink/convert/generic.js', 'utils/extensions/WebsiteDepth/index.js'],
  },
};

// Clients for vector databases AskFiles never selects (the preset sets VECTOR_DB=lancedb). Each file
// listed requires the client at module scope, and upstream loads that file only inside the switch
// on VECTOR_DB (utils/helpers/index.js, getVectorDbClass). pg stays: utils/vectorDbProviders/pgvector
// loads at server start. The model provider SDKs the presets never select (openai, @anthropic-ai/sdk,
// @langchain/anthropic, @langchain/openai, elevenlabs) are loaded at module scope on the startup path
// by the agent and text-to-speech modules, so they stay too; the ones below come only with chromadb.
export const PROVIDERS = {
  server: {
    chromadb: ['utils/vectorDbProviders/chroma/index.js', 'utils/vectorDbProviders/chromacloud/index.js'],
    '@pinecone-database/pinecone': ['utils/vectorDbProviders/pinecone/index.js'],
    'pinecone-client': [],
    '@qdrant/js-client-rest': ['utils/vectorDbProviders/qdrant/index.js'],
    '@zilliz/milvus2-sdk-node': ['utils/vectorDbProviders/milvus/index.js', 'utils/vectorDbProviders/zilliz/index.js'],
    'weaviate-client': ['utils/vectorDbProviders/weaviate/index.js'],
    '@datastax/astra-db-ts': ['utils/vectorDbProviders/astra/index.js'],
  },
  collector: {},
};
// Removed with PROVIDERS but counted on their own in the log: model provider SDKs.
export const PROVIDER_SDKS = new Set(['voyageai', 'cohere-ai', '@google/generative-ai', 'openai', 'ollama']);

// Requires inside node_modules that tolerate a missing package, read and confirmed by hand:
// jsdom sets Canvas to null when require("canvas") throws; langchain's PuppeteerWebBaseLoader imports
// puppeteer only when a page is scraped and turns a failure into an error for that request;
// @langchain/community's vector store and message store integrations are separate entry points
// (@langchain/community/vectorstores/chroma and so on) that neither upstream source nor any other
// package imports (langchain/vectorstores/* re-exports them and is not imported either).
export const OPTIONAL_REQUIRES = [
  /^server: node_modules\/@langchain\/community\/dist\/(vectorstores\/(chroma|astradb|milvus|qdrant)|stores\/message\/astradb)\.c?js requires (chromadb|@datastax\/astra-db-ts|@zilliz\/milvus2-sdk-node|@qdrant\/js-client-rest)$/,
  /^server: node_modules\/jsdom\/lib\/jsdom\/utils\.js requires canvas$/,
  /^collector: node_modules\/(.+\/)?(langchain|@langchain\/community)\/dist\/document_loaders\/web\/puppeteer\.c?js requires puppeteer$/,
];

/** Resolves `name` from `fromDir` the way Node does: the nearest node_modules/<name> upwards. */
export function resolvePackage(name, fromDir, stopDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === stopDir) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Package directories reachable from the tree root through dependencies, optional and peer ones.
 * `extraRoots` are names the root itself requires without declaring them; upstream has a few.
 */
export function reachable(treeDir, skipNames = new Set(), extraRoots = []) {
  const seen = new Set();
  const queue = [treeDir];
  while (queue.length) {
    const dir = queue.shift();
    const pkg = readJson(path.join(dir, 'package.json')) ?? {};
    // An optional peer that is being removed (jsdom's canvas) is not a reason to keep it; other
    // optional peers count (openai's ws, which openai code requires).
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter(
      (n) => !(skipNames.has(n) && pkg.peerDependenciesMeta?.[n]?.optional),
    );
    const names = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...peers,
      ...(dir === treeDir ? extraRoots : []),
    ]);
    for (const name of names) {
      // Skipped at the tree root only: a package that stays and depends on a root keeps it.
      if (dir === treeDir && skipNames.has(name)) continue;
      const found = resolvePackage(name, dir, treeDir);
      if (found && !seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  return seen;
}

/** Required (non-optional, non-peer) dependencies that resolve to a package about to be removed. */
export function brokenDependencies(treeDir, gone) {
  const broken = [];
  for (const dir of reachable(treeDir)) {
    if (gone.has(dir)) continue;
    const pkg = readJson(path.join(dir, 'package.json')) ?? {};
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const found = resolvePackage(name, dir, treeDir);
      // A dependency already missing before this step (an @types package the dev step removed) is not this step's doing.
      if (found && gone.has(found)) broken.push(`${relPosix(treeDir, dir)} needs ${name}`);
    }
  }
  return broken;
}

const REQUIRE = /(?:require\(|import\(|from\s+)\s*["']([^"'./][^"']*)["']/g;

function scanRequires(file, names, onHit) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(REQUIRE)) {
    const spec = m[1];
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (names.has(name)) onHit(name);
  }
}

/** Upstream source files (outside node_modules and tests) that require each package name. */
export function requireSites(treeDir, names) {
  const sites = new Map([...names].map((n) => [n, []]));
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__', 'public', 'storage'].includes(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
        scanRequires(abs, names, (name) => sites.get(name).push(relPosix(treeDir, abs)));
      }
    }
  };
  visit(treeDir);
  return sites;
}

/**
 * Packages that stay but whose code requires a name that would then resolve to nothing: an
 * undeclared dependency on something only a removed package brought in.
 */
export function undeclaredUses(treeDir, gone, goneNames) {
  const hits = [];
  for (const dir of packageDirs(path.join(treeDir, 'node_modules'))) {
    if (gone.has(dir) || [...gone].some((g) => dir.startsWith(g + path.sep))) continue;
    walkFiles(dir, (file, name) => {
      if (file.includes(`${path.sep}node_modules${path.sep}`, dir.length) || !/\.(js|mjs|cjs)$/.test(name)) return;
      scanRequires(file, goneNames, (req) => {
        const found = resolvePackage(req, path.dirname(file), treeDir);
        if (!found || gone.has(found)) hits.push(`${relPosix(treeDir, file)} requires ${req}`);
      });
    });
  }
  return hits;
}

export function pruneUnused(treeDir, unused, dryRun, log = console.log) {
  // A root already gone (a tree restored from the CI cache was pruned before) is skipped, so the
  // step can run again on its own output.
  const roots = Object.keys(unused).filter((name) => {
    if (resolvePackage(name, treeDir, treeDir)) return true;
    log(`[prune] ${name} is not installed in ${path.basename(treeDir)}, nothing to remove`);
    return false;
  });
  if (roots.length === 0) return [];
  // Every package upstream source requires stays, with what it depends on, even when only a removed
  // root declared it (collector/utils/shell.js imports strip-ansi, which only puppeteer pulls in).
  const installed = packageDirs(path.join(treeDir, 'node_modules')).map(
    (d) => readJson(path.join(d, 'package.json'))?.name,
  );
  const required = [...requireSites(treeDir, new Set(installed.filter(Boolean)))]
    .filter(([name, files]) => files.length > 0 && !roots.includes(name))
    .map(([name]) => name);
  const before = reachable(treeDir, new Set(), required);
  const after = reachable(treeDir, new Set(roots), required);
  // Only what the removed roots alone pulled in; packages nothing reached before stay as they were.
  const gone = new Set([...before].filter((d) => !after.has(d)));
  const names = new Map([...gone].map((d) => [d, readJson(path.join(d, 'package.json'))?.name]));
  const errors = [];
  for (const root of roots) {
    if (![...names.values()].includes(root)) errors.push(`${root} is still a dependency of a package that stays`);
  }
  const sites = requireSites(treeDir, new Set(roots));
  for (const [name, files] of sites) {
    for (const f of new Set(files)) if (!unused[name].includes(f)) errors.push(`${f} requires ${name}`);
  }
  errors.push(...brokenDependencies(treeDir, gone));
  // Nothing removed may be required at module scope by a file the process loads at start: every
  // request through the server or collector would then fail.
  const graph = loadGraph(treeDir);
  for (const name of new Set(names.values())) {
    for (const site of graph.sites.get(name) ?? []) {
      if (!site.startup || site.lazy) continue;
      // A nested copy of the same name (chromadb's own openai) going does not affect a site that resolves elsewhere.
      const resolved = resolvePackage(name, path.dirname(path.join(treeDir, site.file)), treeDir);
      if (!resolved || gone.has(resolved))
        errors.push(`${site.file} requires ${name} at module load, on the startup path`);
    }
  }
  const tree = path.basename(treeDir);
  errors.push(
    ...undeclaredUses(treeDir, gone, new Set(names.values())).filter(
      (h) => !OPTIONAL_REQUIRES.some((re) => re.test(`${tree}: ${h}`)),
    ),
  );
  if (errors.length) throw new Error(`refusing to remove unused packages from ${treeDir}:\n  ${errors.join('\n  ')}`);

  const removed = [...gone].map((d) => ({ path: d, bytes: dirSize(d), why: names.get(d) }));
  if (!dryRun) {
    for (const d of gone) fs.rmSync(d, { recursive: true, force: true });
    removeDanglingBins(path.join(treeDir, 'node_modules'));
  }
  return removed;
}

function removeDanglingBins(nodeModules) {
  const scan = (nm) => {
    const bin = path.join(nm, '.bin');
    if (fs.existsSync(bin)) {
      for (const link of fs.readdirSync(bin)) {
        const abs = path.join(bin, link);
        if (fs.lstatSync(abs).isSymbolicLink() && !fs.existsSync(abs)) fs.rmSync(abs);
      }
    }
  };
  scan(nodeModules);
  for (const d of packageDirs(nodeModules)) {
    if (fs.existsSync(path.join(d, 'node_modules'))) scan(path.join(d, 'node_modules'));
  }
}

// ---- longpaths ------------------------------------------------------------------------------

/**
 * The deepest install folder the Windows build expects, up to resources\: the per-user NSIS folder
 * under a 20 character user name, the longest a local account can have.
 */
export const WINDOWS_INSTALL_PREFIX = 'C:\\Users\\' + 'u'.repeat(20) + '\\AppData\\Local\\Programs\\AskFiles\\';
export const WINDOWS_MAX_PATH = 260;

// A compiled TypeScript module with nothing in it but the CommonJS marker and comments.
const EMPTY_MODULE =
  /^\s*(?:"use strict";|'use strict';)?\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\s*(?:\/\/[^\n]*\s*)*$/;

function packageRootOf(file, nodeModules) {
  let dir = path.dirname(file);
  while (dir.startsWith(nodeModules) && dir !== nodeModules) {
    if (isPackageRoot(dir)) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Some generated SDKs (elevenlabs 0.5.0, a text-to-speech client the server loads at start) ship
 * request type files named after whole API routes, over 270 characters once installed. Installers,
 * Explorer and tools without long path support fail on them. Such a file is removed only when it
 * is an empty module (the compiled form of a TypeScript file holding only types) and no other file
 * of its package names it in a module path, so no require can reach it. Anything else stays and the
 * package check (scripts/check-windows-package.mjs) reports it.
 */
export function pruneLongPaths(treeDir, dryRun) {
  const nodeModules = path.join(treeDir, 'node_modules');
  const prefix = WINDOWS_INSTALL_PREFIX + 'resources\\' + path.basename(treeDir) + '\\';
  const long = [];
  walkFiles(nodeModules, (file) => {
    if (prefix.length + path.relative(treeDir, file).length >= WINDOWS_MAX_PATH) long.push(file);
  });
  const removed = [];
  const textOf = new Map();
  const packageText = (root) => {
    if (!textOf.has(root)) {
      const parts = [];
      walkFiles(root, (f) => {
        if (/\.(c?js|mjs|json)$/.test(f) && fs.statSync(f).size < 1_000_000)
          parts.push([f, fs.readFileSync(f, 'utf8')]);
      });
      textOf.set(root, parts);
    }
    return textOf.get(root);
  };
  for (const file of long) {
    if (!/\.js$/.test(file) || fs.statSync(file).size > 4096) continue;
    if (!EMPTY_MODULE.test(fs.readFileSync(file, 'utf8'))) continue;
    const root = packageRootOf(file, nodeModules);
    if (!root) continue;
    // A module path ending in the file's name, as require, import or export-from write it; the
    // name alone also appears in JSDoc type comments (@param {Pkg.Name}), which load nothing.
    const stem = path.basename(file, '.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const asPath = new RegExp(`['"\`][^'"\`\\n]*/${stem}(?:\\.js)?['"\`]`);
    if (packageText(root).some(([f, text]) => f !== file && asPath.test(text))) continue;
    removed.push({ path: file, bytes: fs.statSync(file).size, why: 'empty module with a path over MAX_PATH' });
    if (!dryRun) fs.rmSync(file);
  }
  return removed;
}

// ---- command line ---------------------------------------------------------------------------

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export function prune({ upstreamDir, target, steps = STEPS, dryRun = false, log = console.log }) {
  if (!TARGETS.includes(target)) throw new Error(`unknown target ${target} (expected ${TARGETS.join(' or ')})`);
  const summary = [];
  // Fixed order regardless of how --steps lists them, so measurements stay comparable.
  for (const step of STEPS.filter((s) => steps.includes(s))) {
    for (const tree of TREES) {
      const treeDir = path.join(upstreamDir, tree);
      const nm = path.join(treeDir, 'node_modules');
      if (step === 'longpaths' && target !== 'win32-x64') continue;
      const removed =
        step === 'platform'
          ? prunePlatform(nm, target, dryRun)
          : step === 'dev'
            ? pruneDev(nm, dryRun)
            : step === 'longpaths'
              ? pruneLongPaths(treeDir, dryRun)
              : pruneUnused(treeDir, (step === 'unused' ? UNUSED : PROVIDERS)[tree], dryRun, log);
      const bytes = removed.reduce((s, r) => s + r.bytes, 0);
      summary.push({ step, tree, count: removed.length, bytes });
      log(
        `[prune] ${step} ${tree}: ${dryRun ? 'would remove' : 'removed'} ${removed.length} paths, ${(bytes / 1048576).toFixed(1)} MB`,
      );
      if (step === 'providers' && removed.length) {
        const sdk = removed.filter((r) => PROVIDER_SDKS.has(r.why)).reduce((s, r) => s + r.bytes, 0);
        log(
          `[prune] providers ${tree}: model provider SDKs ${mb(sdk)}, vector database clients and their dependencies ${mb(bytes - sdk)}`,
        );
      }
      if (step !== 'dev') for (const r of removed) log(`[prune]   ${path.relative(nm, r.path)} (${r.why})`);
    }
  }
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const upstreamDir = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : undefined;
  const target = opt('--target');
  const steps = (opt('--steps') ?? STEPS.join(',')).split(',');
  if (!upstreamDir || !target || steps.some((s) => !STEPS.includes(s))) {
    console.error(
      `usage: node scripts/prune.mjs <upstreamDir> --target <${TARGETS.join('|')}> [--steps ${STEPS.join(',')}] [--dry-run]`,
    );
    process.exit(2);
  }
  try {
    prune({ upstreamDir, target, steps, dryRun: args.includes('--dry-run') });
  } catch (err) {
    console.error(`[prune] ERROR: ${err.message}`);
    process.exit(1);
  }
}
