import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTALLER_LICENSE, installerLicenseBytes, installerLicenseText } from './installer-license.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').trimEnd();

describe('Windows installer license page', () => {
  it('is the committed build/license.txt (regenerate with node scripts/installer-license.mjs)', () => {
    expect(fs.readFileSync(INSTALLER_LICENSE).equals(installerLicenseBytes())).toBe(true);
  });

  it("carries AskFiles' license, the NVIDIA terms and the Microsoft runtime terms in full", () => {
    const text = installerLicenseText();
    expect(text).toContain(read('LICENSE'));
    expect(text).toContain(read('NOTICE'));
    expect(text).toContain(read('scripts/notices/msvc-runtime-LICENSE.txt'));
    for (const f of ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll']) expect(text).toContain(f);
    expect(text).toContain('https://docs.nvidia.com/cuda/eula/index.html');
    expect(text).toMatch(/not\s+covered by the Apache License/);
  });

  it('is shown by the installer, which keeps its one-click per-user install', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
    const nsis = yml.slice(yml.indexOf('\nnsis:'));
    expect(nsis).toMatch(/\n {2}license: build\/license\.txt\n/);
    expect(nsis).toMatch(/\n {2}oneClick: true\n/);
    expect(nsis).toMatch(/\n {2}perMachine: false\n/);
  });
});
