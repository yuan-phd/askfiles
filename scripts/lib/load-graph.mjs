// Which upstream files a process loads at start, and where each package is required from, so
// scripts/prune.mjs can refuse a package that upstream loads at module load time. Starting at
// <treeDir>/index.js, follows every relative require or import that runs at module scope (not
// inside a function); requires inside functions run only when that code path is taken.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
// acorn is a dev dependency of the shell; prune.mjs runs from the repository during scripts/build.sh.
const acorn = require('acorn');

const SKIP = new Set(['node_modules', '__tests__', 'public', 'storage']);

function sourceFiles(treeDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(abs);
    }
  };
  walk(treeDir);
  return out;
}

function parse(source) {
  const options = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    return acorn.parse(source, { ...options, sourceType: 'module', allowAwaitOutsideFunction: true });
  } catch {
    return acorn.parse(source, { ...options, sourceType: 'script' });
  }
}

/** Every literal require(), import() and import declaration in a source, with its scope. */
export function requiresIn(source) {
  const found = [];
  const visit = (node, inFunction) => {
    if (!node || typeof node.type !== 'string') return;
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments[0]?.type === 'Literal' &&
      typeof node.arguments[0].value === 'string'
    ) {
      found.push({ spec: node.arguments[0].value, lazy: inFunction });
    }
    if (node.type === 'ImportExpression' && node.source.type === 'Literal')
      found.push({ spec: node.source.value, lazy: inFunction });
    if (node.type === 'ImportDeclaration') found.push({ spec: node.source.value, lazy: false });
    const nested = inFunction || /Function/.test(node.type);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child, nested);
      else if (value && typeof value.type === 'string') visit(value, nested);
    }
  };
  visit(parse(source), false);
  return found;
}

export const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/**
 * Files loaded at start from <treeDir>/index.js, and for every package name the places upstream
 * requires it: { file, lazy, startup }. A file that does not parse fails the call.
 */
export function loadGraph(treeDirIn) {
  const treeDir = path.resolve(treeDirIn);
  const requires = new Map();
  for (const file of sourceFiles(treeDir)) requires.set(file, requiresIn(fs.readFileSync(file, 'utf8')));
  const resolveLocal = (from, spec) => {
    const base = path.resolve(path.dirname(from), spec);
    return [base, `${base}.js`, path.join(base, 'index.js')].find((c) => requires.has(c)) ?? null;
  };
  const startup = new Set();
  const queue = [path.join(treeDir, 'index.js')];
  while (queue.length) {
    const file = queue.pop();
    if (startup.has(file) || !requires.has(file)) continue;
    startup.add(file);
    for (const r of requires.get(file)) {
      if (r.lazy || !r.spec.startsWith('.')) continue;
      const target = resolveLocal(file, r.spec);
      if (target) queue.push(target);
    }
  }
  const sites = new Map();
  for (const [file, list] of requires) {
    for (const r of list) {
      if (r.spec.startsWith('.') || r.spec.startsWith('node:')) continue;
      const name = packageOf(r.spec);
      if (!sites.has(name)) sites.set(name, []);
      sites.get(name).push({ file: path.relative(treeDir, file), lazy: r.lazy, startup: startup.has(file) });
    }
  }
  return { startup, sites };
}
