import { execFile } from 'node:child_process';
import os from 'node:os';
import nodePath from 'node:path';
import type { Env } from './config.js';

export interface AppDirs {
  /** Replaces app.getPath('userData'). */
  userData: string;
  /** Replaces app.getPath('logs'). */
  logs: string;
}

/**
 * Where the app keeps its data on this platform, or null where Electron's defaults are already
 * right (macOS: ~/Library/Application Support/AskFiles and ~/Library/Logs/AskFiles).
 *
 * Windows: %LOCALAPPDATA%\AskFiles, logs in its logs folder. Electron's default userData is the
 * roaming %APPDATA%, which a domain profile copies between machines at every sign-in; gigabytes of
 * models and an index of local files belong to this machine (docs/windows.md).
 */
export function appDirs(platform: NodeJS.Platform, env: Env, o: { dev?: boolean } = {}): AppDirs | null {
  if (platform !== 'win32') return null;
  const local =
    env.LOCALAPPDATA || (env.USERPROFILE ? nodePath.win32.join(env.USERPROFILE, 'AppData', 'Local') : undefined);
  if (!local) throw new Error('neither LOCALAPPDATA nor USERPROFILE is set');
  const userData = nodePath.win32.join(local, o.dev ? 'AskFiles-dev' : 'AskFiles');
  return { userData, logs: nodePath.win32.join(userData, 'logs') };
}

export type RunCommand = (command: string, args: string[]) => Promise<string>;

const runCommand: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

export interface RamReading {
  /** What the tier choice uses. */
  bytes: number;
  /** os.totalmem(): memory the operating system can use. */
  usableBytes: number;
  source: 'totalmem' | 'installed';
}

/**
 * The machine's RAM for the tier choice, which matches tiers to the marketed size (presets/tier.ts).
 * A Mac reports that size in os.totalmem(). Windows reports the memory left after firmware and
 * graphics reservations, so a 16 GB PC shows 15.2 to 15.9 GiB and would fall to the 8 GB tier;
 * there the installed size comes from the memory modules (Win32_PhysicalMemory), accepted only
 * when it is at least the usable size and at most twice it. Any failure falls back to totalmem.
 */
export async function machineRam(
  platform: NodeJS.Platform,
  o: { totalmem?: () => number; run?: RunCommand; systemRoot?: string } = {},
): Promise<RamReading> {
  const usableBytes = (o.totalmem ?? os.totalmem)();
  const fallback: RamReading = { bytes: usableBytes, usableBytes, source: 'totalmem' };
  if (platform !== 'win32') return fallback;
  const powershell = nodePath.win32.join(
    o.systemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    const out = await (o.run ?? runCommand)(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum',
    ]);
    const text = out.trim();
    if (!/^\d+$/.test(text)) return fallback;
    const installed = Number(text);
    if (installed < usableBytes || installed > 2 * usableBytes) return fallback;
    return { bytes: installed, usableBytes, source: 'installed' };
  } catch {
    return fallback;
  }
}
