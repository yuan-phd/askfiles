import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trimRuntimes } from './ollama-runtimes.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'askfiles-ollama-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel, bytes = 10) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes));
}

// The layout of ollama-windows-amd64.zip v0.40.4 (lib/ollama, listed from the release archive).
function windowsPackage() {
  put('ollama.exe');
  put('lib/ollama/ggml-cpu-x64.dll');
  put('lib/ollama/ggml-base.dll');
  put('lib/ollama/LLAMA_CPP_LICENSE');
  put('lib/ollama/cuda_v12/ggml-cuda.dll', 100);
  put('lib/ollama/cuda_v12/cublas64_12.dll', 100);
  put('lib/ollama/cuda_v13/ggml-cuda.dll', 50);
  put('lib/ollama/vulkan/ggml-vulkan.dll', 5);
}

describe('trimRuntimes', () => {
  it('keeps the CPU libraries and the named runtime, removes the other GPU runtimes', () => {
    windowsPackage();
    const r = trimRuntimes({ ollamaDir: dir, keep: ['cuda_v12'] });
    expect(r.kept).toEqual([{ name: 'cuda_v12', bytes: 200 }]);
    expect(r.removed).toEqual([
      { name: 'cuda_v13', bytes: 50 },
      { name: 'vulkan', bytes: 5 },
    ]);
    expect(existsSync(join(dir, 'lib/ollama/cuda_v12/ggml-cuda.dll'))).toBe(true);
    expect(existsSync(join(dir, 'lib/ollama/ggml-cpu-x64.dll'))).toBe(true);
    expect(existsSync(join(dir, 'lib/ollama/LLAMA_CPP_LICENSE'))).toBe(true);
    expect(existsSync(join(dir, 'lib/ollama/cuda_v13'))).toBe(false);
    expect(existsSync(join(dir, 'lib/ollama/vulkan'))).toBe(false);
  });

  it('removes nothing on a dry run', () => {
    windowsPackage();
    trimRuntimes({ ollamaDir: dir, keep: ['cuda_v12'], dryRun: true });
    expect(existsSync(join(dir, 'lib/ollama/vulkan'))).toBe(true);
  });

  it('refuses a folder that is not the Windows package, or a runtime it does not hold', () => {
    put('ollama');
    expect(() => trimRuntimes({ ollamaDir: dir, keep: ['cuda_v12'] })).toThrow(/ollama\.exe is missing/);
    windowsPackage();
    expect(() => trimRuntimes({ ollamaDir: dir, keep: ['rocm'] })).toThrow(
      /no rocm in .* \(found cuda_v12, cuda_v13, vulkan\)/,
    );
  });
});
