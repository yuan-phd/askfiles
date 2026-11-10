import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNTIME_GROUPS, noticeText, readVersion, windowsRuntimeLines, windowsRuntimes } from './windows-runtimes.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-winrt-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Invented stand-ins: a version resource string in UTF-16 or a clang version string, no real binary. */
function file(rel, content = Buffer.alloc(0)) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}
const peVersion = (v) => Buffer.from(`\0\0FileVersion\0\0${v}\0\0ProductName\0`, 'utf16le');
const clang = (v) => Buffer.from(`xx\0clang version ${v}\0yy`, 'latin1');
const LLVM = '18.1.8 (https://github.com/llvm/llvm-project.git 3b5b5c1ec4a3095ab096dd780e84d7ab81f3d7ff)';

function windowsTree({ msvc = '14.44.35211.0', llvm = LLVM } = {}) {
  file('ollama.exe');
  file('lib/ollama/ggml-base.dll');
  file('lib/ollama/llama-server.exe');
  file('lib/ollama/libc++.dll', clang(llvm));
  file('lib/ollama/libomp.dll');
  file('lib/ollama/libunwind.dll');
  file('lib/ollama/libwinpthread-1.dll');
  file('lib/ollama/cuda_v12/msvcp140.dll', peVersion(msvc));
  file('lib/ollama/cuda_v12/vcruntime140_1.dll');
  file('lib/ollama/cuda_v12/cudart64_12.dll');
  file('lib/ollama/cuda_v12/ggml-cuda.dll');
}

describe('windowsRuntimes', () => {
  it('finds nothing outside the Windows Ollama package', () => {
    file('ollama');
    file('libggml-base.dylib');
    expect(windowsRuntimes(dir)).toEqual({ groups: [], errors: [] });
  });

  it('puts every file in a group and lists each group with its license texts', () => {
    windowsTree();
    const { groups, errors } = windowsRuntimes(dir);
    expect(errors).toEqual([]);
    expect(groups.map((g) => g.id)).toEqual(['msvc', 'llvm', 'winpthreads', 'cuda', 'ollama']);
    expect(groups.find((g) => g.id === 'msvc').files).toEqual([
      'lib/ollama/cuda_v12/msvcp140.dll',
      'lib/ollama/cuda_v12/vcruntime140_1.dll',
    ]);
    const { lines, texts } = windowsRuntimeLines(groups);
    expect(lines.join('\n')).toContain('Files: lib/ollama/libwinpthread-1.dll');
    expect(texts.map((t) => t.heading)).toHaveLength(5);
    expect(texts.map((t) => t.text).join('\n')).toContain('MICROSOFT VISUAL C++ 2015 - 2022 RUNTIME');
  });

  it('fails on a file in no group and on runtime versions the texts were not taken for', () => {
    windowsTree({ msvc: '15.0.1.0', llvm: '19.1.0 (https://github.com/llvm/llvm-project.git abc)' });
    file('lib/ollama/mystery.dll');
    expect(windowsRuntimes(dir).errors).toEqual([
      'lib/ollama/cuda_v12/msvcp140.dll: version 15.0.1.0 is not the one the license texts in scripts/notices were taken for',
      'lib/ollama/libc++.dll: version 19.1.0 (https://github.com/llvm/llvm-project.git abc) is not the one the license texts in scripts/notices were taken for',
      'lib/ollama/mystery.dll is in no group of scripts/lib/windows-runtimes.mjs, so its license is not covered',
    ]);
  });

  it('reads both kinds of version', () => {
    file('a.dll', peVersion('14.44.35211.0'));
    file('b.dll', clang(LLVM));
    expect(readVersion(path.join(dir, 'a.dll'), 'fileVersion')).toBe('14.44.35211.0');
    expect(readVersion(path.join(dir, 'b.dll'), 'clang')).toBe(LLVM);
  });

  it('has every license text it names, as fetched', () => {
    for (const g of RUNTIME_GROUPS) for (const t of g.texts) expect(noticeText(t).length, t).toBeGreaterThan(500);
    expect(noticeText('msvc-runtime-LICENSE.txt')).toMatch(/EULA ID: Cpp_2015-2022_ENU\.1033$/);
    expect(noticeText('llvm-libcxx-LICENSE.TXT')).toMatch(/Apache License v2\.0 with LLVM Exceptions/);
    expect(noticeText('winpthreads-COPYING')).toMatch(/^Copyright \(c\) 2011 mingw-w64 project/);
  });
});
