import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  binaryKind,
  entryDirs,
  foreignBinary,
  isDevFile,
  pruneDev,
  pruneLongPaths,
  prunePlatform,
  pruneUnused,
  WINDOWS_INSTALL_PREFIX,
} from './prune.mjs';

let root;
function write(rel, content = '') {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}
function pkg(dir, json) {
  write(join(dir, 'package.json'), JSON.stringify(json));
  write(join(dir, 'index.js'), 'module.exports = 1;');
}
const exists = (rel) => existsSync(join(root, rel));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'askfiles-prune-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Headers: 20 bytes, enough for binaryKind.
function elf(machine) {
  const b = Buffer.alloc(20);
  b.write('7f454c46', 'hex');
  b[5] = 1;
  b.writeUInt16LE(machine, 18);
  return b;
}
function macho(cpu, filetype) {
  const b = Buffer.alloc(20);
  b.write('cffaedfe', 'hex');
  b.writeUInt32LE(cpu, 4);
  b.writeUInt32LE(filetype, 12);
  return b;
}
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
const fat = Buffer.from('cafebabe00000002' + '00'.repeat(12), 'hex');
const javaClass = Buffer.from('cafebabe00000034' + '00'.repeat(12), 'hex');
const pe = Buffer.concat([Buffer.from('4d5a', 'hex'), Buffer.alloc(18)]);
// A PE file with its COFF header at 0x80, as Windows linkers write it.
function peFile(machine, dll) {
  const b = Buffer.alloc(0x200);
  b.write('4d5a', 'hex');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('50450000', 0x80, 'hex');
  b.writeUInt16LE(machine, 0x84);
  b.writeUInt16LE(dll ? 0x2022 : 0x0022, 0x80 + 22);
  return b;
}

describe('binaryKind and foreignBinary', () => {
  it.each([
    ['ELF x86-64', elf(0x3e), true, false],
    ['ELF aarch64', elf(0xb7), true, true],
    ['PE', pe, true, true],
    ['Mach-O arm64 library', macho(ARM64, 6), false, true],
    ['Mach-O x86_64 library', macho(X86_64, 6), true, true],
    ['Mach-O x86_64 bundle (.node)', macho(X86_64, 8), true, true],
    ['Mach-O x86_64 executable (Rosetta can run it)', macho(X86_64, 2), false, true],
    ['fat Mach-O', fat, false, true],
  ])('%s', (_, header, onMac, onLinux) => {
    const kind = binaryKind(header);
    expect(foreignBinary(kind, 'darwin-arm64')).toBe(onMac);
    expect(foreignBinary(kind, 'linux-x64')).toBe(onLinux);
  });

  it.each([
    ['PE x64 DLL (.node)', peFile(0x8664, true), false],
    ['PE x64 executable', peFile(0x8664, false), false],
    ['PE arm64 DLL', peFile(0xaa64, true), true],
    ['PE x86 DLL (cannot load into x64)', peFile(0x14c, true), true],
    ['PE x86 executable (WOW64 runs it)', peFile(0x14c, false), false],
    ['MZ without a readable PE header', pe, false],
    ['ELF x86-64', elf(0x3e), true],
    ['Mach-O arm64 library', macho(ARM64, 6), true],
    ['fat Mach-O', fat, true],
  ])('win32-x64: %s', (_, header, foreign) => {
    const kind = binaryKind(header);
    expect(foreignBinary(kind, 'win32-x64')).toBe(foreign);
    // A readable PE header changes nothing for the other targets: every PE file is foreign there.
    if (kind.format === 'pe') {
      expect(foreignBinary(kind, 'darwin-arm64')).toBe(true);
      expect(foreignBinary(kind, 'linux-x64')).toBe(true);
    }
  });

  it('reads the machine of a PE file from its COFF header', () => {
    expect(binaryKind(peFile(0x8664, true))).toEqual({ format: 'pe', machine: 0x8664, dll: true });
    expect(binaryKind(pe)).toEqual({ format: 'pe' });
  });

  it('does not take a Java class file or text for a binary', () => {
    expect(binaryKind(javaClass)).toBeNull();
    expect(binaryKind(Buffer.from('module.exports = 1; // twenty bytes+'))).toBeNull();
  });
});

describe('prunePlatform', () => {
  it('keeps x64 Windows binaries and drops the rest for win32-x64', () => {
    write('nm/onnx/bin/napi-v3/win32/x64/onnxruntime_binding.node', peFile(0x8664, true));
    write('nm/onnx/bin/napi-v3/win32/arm64/onnxruntime_binding.node', peFile(0xaa64, true));
    write('nm/onnx/bin/napi-v3/linux/x64/libonnxruntime.so', elf(0x3e));
    write('nm/sharp-win32-ia32/lib/sharp.node', peFile(0x14c, true));
    write('nm/rg/bin/rg.exe', peFile(0x8664, false));
    write('nm/a/index.js', 'module.exports = "a long enough javascript file";');
    const removed = prunePlatform(join(root, 'nm'), 'win32-x64', false);
    expect(removed.map((r) => r.why).sort()).toEqual(['elf', 'pe', 'pe']);
    expect(exists('nm/onnx/bin/napi-v3/win32/x64/onnxruntime_binding.node')).toBe(true);
    expect(exists('nm/rg/bin/rg.exe')).toBe(true);
    expect(exists('nm/a/index.js')).toBe(true);
    expect(exists('nm/onnx/bin/napi-v3/win32/arm64/onnxruntime_binding.node')).toBe(false);
    expect(exists('nm/sharp-win32-ia32/lib/sharp.node')).toBe(false);
  });

  it('removes only what the target cannot load', () => {
    write('nm/a/lib.so', elf(0x3e));
    write('nm/a/lib.dylib', macho(ARM64, 6));
    write('nm/a/x64.dylib', macho(X86_64, 6));
    write('nm/a/index.js', 'module.exports = "a long enough javascript file";');
    const removed = prunePlatform(join(root, 'nm'), 'darwin-arm64', false);
    expect(removed.map((r) => r.why).sort()).toEqual(['elf', 'macho']);
    expect(exists('nm/a/lib.dylib')).toBe(true);
    expect(exists('nm/a/index.js')).toBe(true);
    expect(exists('nm/a/lib.so')).toBe(false);
  });

  it('changes nothing in a dry run', () => {
    write('nm/a/lib.so', elf(0x3e));
    expect(prunePlatform(join(root, 'nm'), 'darwin-arm64', true)).toHaveLength(1);
    expect(exists('nm/a/lib.so')).toBe(true);
  });
});

describe('dev files', () => {
  it.each(['a.js.map', 'a.css.map', 'a.d.ts', 'a.d.mts', 'README.md', 'CHANGELOG', 'history.md'])('%s is dev', (n) => {
    expect(isDevFile(n)).toBe(true);
  });
  it.each(['a.js', 'a.ts', 'LICENSE', 'license.md', 'a.map', 'readme.js', 'data.json'])('%s is kept', (n) => {
    expect(isDevFile(n)).toBe(false);
  });

  it('finds folders entry points use', () => {
    expect([
      ...entryDirs({ main: './test/index.js', exports: { '.': { require: './docs/a.js' } }, bin: 'x.js' }),
    ]).toEqual(['test', 'docs']);
  });

  it('removes dev files and folders but keeps what entries point at and deeper folders', () => {
    pkg('nm/a', { name: 'a' });
    write('nm/a/index.js.map', 'x');
    write('nm/a/index.d.ts', 'x');
    write('nm/a/README.md', 'x');
    write('nm/a/LICENSE', 'x');
    write('nm/a/test/data.pdf', 'x');
    write('nm/a/dist/doc/code.js', 'x');
    pkg('nm/b', { name: 'b', main: 'test/main.js' });
    write('nm/b/test/main.js', 'x');
    write('nm/@types/node/index.d.ts', 'x');
    write('nm/@types/node/package.json', '{"name":"@types/node"}');
    pkg('nm/@types/odd', { name: '@types/odd' });
    pkg('nm/nolicense', { name: 'nolicense' });
    write('nm/nolicense/README.md', 'License: MIT');
    write('nm/nolicense/CHANGELOG.md', 'x');
    pruneDev(join(root, 'nm'), false);
    expect(exists('nm/a/index.js')).toBe(true);
    expect(exists('nm/a/LICENSE')).toBe(true);
    expect(exists('nm/a/dist/doc/code.js')).toBe(true);
    expect(exists('nm/b/test/main.js')).toBe(true);
    expect(exists('nm/@types/odd/index.js')).toBe(true);
    expect(exists('nm/nolicense/README.md')).toBe(true);
    expect(exists('nm/nolicense/CHANGELOG.md')).toBe(false);
    for (const gone of ['nm/a/index.js.map', 'nm/a/index.d.ts', 'nm/a/README.md', 'nm/a/test', 'nm/@types/node']) {
      expect(exists(gone)).toBe(false);
    }
  });
});

describe('pruneUnused', () => {
  // tree: root depends on keep and drop; drop depends on only-drop and shared; keep depends on shared.
  function tree(extraRootDeps = {}) {
    pkg('t', { name: 't', dependencies: { keep: '1', drop: '1', ...extraRootDeps } });
    pkg('t/node_modules/keep', { name: 'keep', dependencies: { shared: '1' } });
    pkg('t/node_modules/drop', { name: 'drop', dependencies: { 'only-drop': '1', shared: '1' } });
    pkg('t/node_modules/only-drop', { name: 'only-drop' });
    pkg('t/node_modules/shared', { name: 'shared' });
    pkg('t/node_modules/drop/node_modules/nested', { name: 'nested' });
    pkg('t/node_modules/orphan', { name: 'orphan' });
    write('t/src/use.js', 'const d = require("drop");');
  }

  it('removes the root and what only it pulled in', () => {
    tree();
    const removed = pruneUnused(join(root, 't'), { drop: ['src/use.js'] }, false, () => {});
    expect(removed.map((r) => r.why).sort()).toEqual(['drop', 'only-drop']);
    expect(exists('t/node_modules/shared')).toBe(true);
    expect(exists('t/node_modules/orphan')).toBe(true);
    expect(exists('t/node_modules/drop')).toBe(false);
  });

  it('keeps a package upstream source requires without declaring it', () => {
    tree();
    write('t/src/phantom.js', 'import("only-drop")');
    pruneUnused(join(root, 't'), { drop: ['src/use.js'] }, false, () => {});
    expect(exists('t/node_modules/only-drop')).toBe(true);
  });

  it('refuses when upstream source requires the package outside the listed files', () => {
    tree();
    write('t/src/other.js', 'require("drop/sub")');
    expect(() => pruneUnused(join(root, 't'), { drop: ['src/use.js'] }, false, () => {})).toThrow(
      /src\/other.js requires drop/,
    );
    expect(exists('t/node_modules/drop')).toBe(true);
  });

  it('refuses when a remaining package requires a removed one', () => {
    tree();
    write('t/node_modules/keep/lib.js', 'require("only-drop")');
    expect(() => pruneUnused(join(root, 't'), { drop: ['src/use.js'] }, false, () => {})).toThrow(
      /keep\/lib.js requires only-drop/,
    );
  });

  it('refuses a package required at module scope by a file loaded at start', () => {
    tree();
    write('t/index.js', 'require("./src/boot");');
    write('t/src/boot.js', 'const d = require("drop");');
    expect(() => pruneUnused(join(root, 't'), { drop: ['src/use.js', 'src/boot.js'] }, false, () => {})).toThrow(
      /src\/boot.js requires drop at module load, on the startup path/,
    );
    expect(exists('t/node_modules/drop')).toBe(true);
  });

  it('allows a module-scope require in a file loaded only inside a function', () => {
    tree();
    write('t/index.js', 'function pick() { return require("./src/provider"); }');
    write('t/src/provider.js', 'const d = require("drop");');
    pruneUnused(join(root, 't'), { drop: ['src/use.js', 'src/provider.js'] }, false, () => {});
    expect(exists('t/node_modules/drop')).toBe(false);
  });

  it('skips a package that is already gone, so the step can run twice', () => {
    tree();
    const lines = [];
    pruneUnused(join(root, 't'), { drop: ['src/use.js'] }, false, () => {});
    expect(pruneUnused(join(root, 't'), { drop: ['src/use.js'] }, false, (l) => lines.push(l))).toEqual([]);
    expect(lines.join('\n')).toMatch(/drop is not installed/);
  });

  it('refuses when a package that stays still depends on it', () => {
    tree();
    pkg('t/node_modules/keep', { name: 'keep', dependencies: { shared: '1', drop: '1' } });
    expect(() => pruneUnused(join(root, 't'), { drop: ['src/use.js'] }, false, () => {})).toThrow(
      /drop is still a dependency/,
    );
  });
});

describe('pruneLongPaths', () => {
  const STUB =
    '"use strict";\n/**\n * This file was auto-generated by Fern from our API Definition.\n */\nObject.defineProperty(exports, "__esModule", { value: true });\n';
  // elevenlabs 0.5.0 names request types after whole API routes.
  const longName =
    'BodyRemoveRulesFromThePronunciationDictionaryV1PronunciationDictionariesPronunciationDictionaryIdRemoveRulesPost';
  const reqDir = 'server/node_modules/elevenlabs/api/resources/pronunciationDictionary/client/requests';

  it('removes an unreferenced empty module whose installed path passes MAX_PATH, nothing else', () => {
    write('server/node_modules/elevenlabs/package.json', '{"name":"elevenlabs","main":"./index.js"}');
    write(`${reqDir}/index.js`, STUB);
    write(`${reqDir}/${longName}.js`, STUB);
    // As long, but real code: stays.
    write(`${reqDir}/${longName.replace('Body', 'Code')}.js`, 'module.exports = require("./index");');
    // As long and empty, but its package names it: stays.
    write(`${reqDir}/${longName.replace('Body', 'Used')}.js`, STUB);
    write(
      'server/node_modules/elevenlabs/index.js',
      `require("./api/resources/pronunciationDictionary/client/requests/${longName.replace('Body', 'Used')}");`,
    );
    const installed = (rel) => WINDOWS_INSTALL_PREFIX.length + 'resources\\'.length + rel.length;
    expect(installed(`${reqDir}/${longName}.js`)).toBeGreaterThan(260);
    const removed = pruneLongPaths(join(root, 'server'), false);
    expect(removed.map((r) => r.path)).toEqual([join(root, reqDir, `${longName}.js`)]);
    expect(exists(`${reqDir}/index.js`)).toBe(true);
    expect(exists(`${reqDir}/${longName.replace('Body', 'Code')}.js`)).toBe(true);
    expect(exists(`${reqDir}/${longName.replace('Body', 'Used')}.js`)).toBe(true);
  });
});
