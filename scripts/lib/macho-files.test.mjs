import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { machoFiles } from './macho-files.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'askfiles-macho-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel, hex) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.concat([Buffer.from(hex, 'hex'), Buffer.alloc(20)]));
}

describe('machoFiles', () => {
  it('lists thin and fat Mach-O files and nothing else', () => {
    write('a/lib.node', 'cffaedfe0c000001');
    write('b/rg', 'cafebabe00000002');
    write('b/Foo.class', 'cafebabe00000034');
    write('c/lib.so', '7f454c46');
    write('c/index.js', '2f2f');
    expect(machoFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual(['a/lib.node', 'b/rg']);
  });
});
