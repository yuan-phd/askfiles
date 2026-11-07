import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  foreignPeFiles,
  INSTALL_PREFIX,
  installPrefix,
  longestPaths,
  NATIVE_MODULES,
  report,
} from './check-windows-package.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'askfiles-winpkg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel, content) {
  const p = join(dir, ...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function pe(machine, dll) {
  const b = Buffer.alloc(0x200);
  b.write('4d5a', 'hex');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('50450000', 0x80, 'hex');
  b.writeUInt16LE(machine, 0x84);
  b.writeUInt16LE(dll ? 0x2022 : 0x22, 0x80 + 22);
  return b;
}

describe('check-windows-package', () => {
  it('flags DLLs of another machine and non-PE binaries, keeps x64 and 32-bit executables', () => {
    put('resources/server/node_modules/a/x64.node', pe(0x8664, true));
    put('resources/server/node_modules/a/arm64.node', pe(0xaa64, true));
    put('resources/server/node_modules/a/x86.dll', pe(0x14c, true));
    put('resources/server/node_modules/a/helper.exe', pe(0x14c, false));
    put(
      'resources/server/node_modules/a/linux.node',
      Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(20)]),
    );
    put('resources/server/node_modules/a/index.js', 'module.exports = 1;');
    const bad = foreignPeFiles(dir)
      .map((b) => `${b.rel}: ${b.why}`)
      .sort();
    expect(bad).toEqual([
      'server\\node_modules\\a\\arm64.node: PE machine 0xaa64 DLL',
      'server\\node_modules\\a\\linux.node: elf',
      'server\\node_modules\\a\\x86.dll: PE machine 0x14c DLL',
    ]);
  });

  it('measures paths as installed under a 20 character user name, with backslashes', () => {
    put('resources/server/node_modules/deep/er/file.js', '');
    put('AskFiles.exe', '');
    const [first] = longestPaths(dir, 1);
    const rel = 'resources\\server\\node_modules\\deep\\er\\file.js';
    expect(first).toEqual({ rel, length: INSTALL_PREFIX.length + rel.length });
    expect(INSTALL_PREFIX).toBe('C:\\Users\\uuuuuuuuuuuuuuuuuuuu\\AppData\\Local\\Programs\\AskFiles\\');
  });

  it('measures the test build under its own, longer folder name (docs/test-build.md)', () => {
    put('resources/a.js', '');
    const prefix = installPrefix('AskFiles Test');
    expect(prefix).toBe('C:\\Users\\uuuuuuuuuuuuuuuuuuuu\\AppData\\Local\\Programs\\AskFiles Test\\');
    expect(installPrefix()).toBe(INSTALL_PREFIX);
    expect(longestPaths(dir, 1, prefix)[0].length).toBe(longestPaths(dir, 1)[0].length + ' Test'.length);
  });

  it('lists every native module the brief names, and reports a failure', () => {
    const names = NATIVE_MODULES.map((m) => m.name).join(' ');
    for (const m of ['lancedb', 'onnxruntime', 'sharp', 'canvas', 'Prisma', 'Ollama']) expect(names).toContain(m);
    const text = report({
      rows: [{ name: 'x', binary: 'a|b', status: 'MISSING', detail: 'no a' }],
      foreign: [],
      longest: [{ rel: 'r', length: 100 }],
      failed: true,
    });
    expect(text).toContain('| x | a\\|b | MISSING | no a |');
    expect(text).toContain('Result: FAILED');
  });
});
