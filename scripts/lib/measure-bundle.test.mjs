import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devKind, findDuplicates, formatSize, measure, walkTree } from './measure-bundle.mjs';

let res;
function file(rel, bytes) {
  const path = join(res, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}
// Size of the package.json that pkg() writes.
const pj = (name) => JSON.stringify({ name }).length;
function pkg(dir, name, bytes) {
  file(join(dir, 'index.js'), bytes);
  writeFileSync(join(res, dir, 'package.json'), JSON.stringify({ name }));
}

beforeEach(() => {
  res = mkdtempSync(join(tmpdir(), 'askfiles-measure-'));
});
afterEach(() => rmSync(res, { recursive: true, force: true }));

describe('devKind', () => {
  it.each([
    ['index.js.map', false, 'source maps'],
    ['index.d.ts', false, 'typings'],
    ['index.d.mts', false, 'typings'],
    ['README.md', false, 'readme and changelog'],
    ['CHANGELOG', false, 'readme and changelog'],
    ['__tests__', true, 'test, example and doc folders'],
    ['examples', true, 'test, example and doc folders'],
  ])('%s', (name, isDir, kind) => {
    expect(devKind(name, isDir)).toBe(kind);
  });

  it.each([
    ['index.js', false],
    ['lib', true],
    ['docs.js', false],
  ])('leaves %s alone', (name, isDir) => {
    expect(devKind(name, isDir)).toBeNull();
  });
});

describe('walkTree', () => {
  it('counts nested packages on their own and scoped packages by full name', () => {
    pkg('server/node_modules/a', 'a', 100);
    pkg('server/node_modules/a/node_modules/b', 'b', 50);
    pkg('server/node_modules/@s/c', '@s/c', 10);
    file('server/node_modules/a/index.js.map', 7);
    file('server/node_modules/.bin/x', 1);
    const { packages, total, files, dev } = walkTree(join(res, 'server/node_modules'));
    const sizes = Object.fromEntries(packages.map((p) => [p.name, p.bytes]));
    expect(sizes).toEqual({ a: 107 + pj('a'), b: 50 + pj('b'), '@s/c': 10 + pj('@s/c') });
    expect(total).toBe(167 + pj('a') + pj('b') + pj('@s/c'));
    expect(files).toBe(7);
    expect(dev.get('source maps')).toBe(7);
  });

  it('falls back to the folder name without a package.json', () => {
    file('server/node_modules/.prisma/client/index.js', 5);
    const { packages } = walkTree(join(res, 'server/node_modules'));
    expect(packages.map((p) => p.name)).toEqual(['.prisma']);
  });
});

describe('findDuplicates', () => {
  it('groups copies by name, largest first', () => {
    const dups = findDuplicates([
      { name: 'x', bytes: 1, path: '1' },
      { name: 'y', bytes: 5, path: '2' },
      { name: 'y', bytes: 5, path: '3' },
      { name: 'z', bytes: 2, path: '4' },
      { name: 'z', bytes: 1, path: '5' },
    ]);
    expect(dups.map((d) => [d.name, d.copies.length, d.bytes])).toEqual([
      ['y', 2, 10],
      ['z', 2, 3],
    ]);
  });
});

describe('measure', () => {
  it('reports both trees and the largest directories in order', () => {
    pkg('server/node_modules/big', 'big', 3 * 1024 * 1024);
    pkg('collector/node_modules/small', 'small', 2048);
    pkg('collector/node_modules/q/node_modules/small', 'small', 1024);
    const { markdown, total } = measure(res, 2);
    expect(total).toBe(3 * 1024 * 1024 + 3072 + pj('big') + 2 * pj('small'));
    expect(markdown).toContain('| 3.0 MB | server/node_modules/big |');
    expect(markdown).toContain('| 2 KB | collector/node_modules/small |');
    expect(markdown).not.toContain('| 1 KB | collector/node_modules/q/node_modules/small |');
    expect(markdown).toContain('| small | 2 | 3 KB |');
  });

  it('fails when a tree is missing', () => {
    pkg('server/node_modules/a', 'a', 1);
    expect(() => measure(res)).toThrow(/collector/);
  });
});

describe('formatSize', () => {
  it.each([
    [512, '1 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [3 * 1024 ** 3, '3.00 GB'],
  ])('%d', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});
