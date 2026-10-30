import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGraph, requiresIn } from './load-graph.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'askfiles-graph-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel, text) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe('requiresIn', () => {
  it('tells module scope from function scope', () => {
    const found = requiresIn(`
      const a = require("a");
      import("b");
      function f() { return require("c"); }
      const g = async () => { await import("d/sub"); };
    `);
    expect(found).toEqual([
      { spec: 'a', lazy: false },
      { spec: 'b', lazy: false },
      { spec: 'c', lazy: true },
      { spec: 'd/sub', lazy: true },
    ]);
  });

  it('reads ES module imports', () => {
    expect(requiresIn('import x from "x";\nexport const y = 1;')).toEqual([{ spec: 'x', lazy: false }]);
  });
});

describe('loadGraph', () => {
  it('follows module-scope relative requires from index.js only', () => {
    write('index.js', 'require("./utils"); function later() { require("./lazy.js"); }');
    write('utils/index.js', 'const pg = require("pg"); const s = require("@scope/pkg/sub");');
    write('lazy.js', 'const chroma = require("chromadb");');
    write('__tests__/t.js', 'require("jest");');
    const { startup, sites } = loadGraph(root);
    expect([...startup].map((f) => f.slice(root.length + 1)).sort()).toEqual(['index.js', 'utils/index.js']);
    expect(sites.get('pg')).toEqual([{ file: 'utils/index.js', lazy: false, startup: true }]);
    expect(sites.get('@scope/pkg')).toEqual([{ file: 'utils/index.js', lazy: false, startup: true }]);
    expect(sites.get('chromadb')).toEqual([{ file: 'lazy.js', lazy: false, startup: false }]);
    expect(sites.has('jest')).toBe(false);
  });
});
