import { describe, expect, it } from 'vitest';
import { appDirs, machineRam } from './platform.js';

const GIB = 1024 ** 3;

describe('appDirs', () => {
  it('keeps Electron defaults on macOS and Linux', () => {
    expect(appDirs('darwin', { LOCALAPPDATA: 'C:\\x' })).toBeNull();
    expect(appDirs('linux', {})).toBeNull();
  });

  it('puts data and logs under LOCALAPPDATA on Windows, not the roaming APPDATA', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
    expect(appDirs('win32', env)).toEqual({
      userData: 'C:\\Users\\u\\AppData\\Local\\AskFiles',
      logs: 'C:\\Users\\u\\AppData\\Local\\AskFiles\\logs',
    });
    expect(appDirs('win32', env, { dev: true })!.userData).toBe('C:\\Users\\u\\AppData\\Local\\AskFiles-dev');
  });

  it('falls back to USERPROFILE and refuses when neither is set', () => {
    expect(appDirs('win32', { USERPROFILE: 'C:\\Users\\u' })!.userData).toBe('C:\\Users\\u\\AppData\\Local\\AskFiles');
    expect(() => appDirs('win32', {})).toThrow(/LOCALAPPDATA/);
  });
});

describe('machineRam', () => {
  const usable = Math.round(15.7 * GIB);
  const run = (out: string) => async (command: string, args: string[]) => {
    expect(command).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.at(-1)).toContain('Win32_PhysicalMemory');
    return out;
  };

  it('uses os.totalmem on macOS without running anything', async () => {
    const r = await machineRam('darwin', {
      totalmem: () => 16 * GIB,
      run: () => Promise.reject(new Error('must not run')),
    });
    expect(r).toEqual({ bytes: 16 * GIB, usableBytes: 16 * GIB, source: 'totalmem' });
  });

  it('uses the installed size on Windows, so a 16 GB PC reporting 15.7 GiB stays in the 16 GB tier', async () => {
    const r = await machineRam('win32', { totalmem: () => usable, run: run(`${16 * GIB}\r\n`), systemRoot: 'D:\\Win' });
    expect(r).toEqual({ bytes: 16 * GIB, usableBytes: usable, source: 'installed' });
  });

  it('falls back to totalmem on a failure, an empty answer or an implausible size', async () => {
    const o = { totalmem: () => usable, systemRoot: 'D:\\Win' };
    for (const out of ['', 'abc', String(8 * GIB), String(64 * GIB)]) {
      expect((await machineRam('win32', { ...o, run: run(out) })).source).toBe('totalmem');
    }
    const failing = await machineRam('win32', { ...o, run: () => Promise.reject(new Error('no powershell')) });
    expect(failing).toEqual({ bytes: usable, usableBytes: usable, source: 'totalmem' });
  });
});
