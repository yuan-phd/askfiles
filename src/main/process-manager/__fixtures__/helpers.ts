import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandSpec, ProcessManagerConfig } from '../config.js';

export const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-child.mjs');

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-pm-'));
}

export function fake(dir: string, name: string, ...args: string[]): CommandSpec {
  return {
    command: process.execPath,
    args: [FAKE, '--name', name, '--record', path.join(dir, 'record.jsonl'), ...args],
    cwd: dir,
  };
}

export function fakeConfig(dir: string, over: Partial<ProcessManagerConfig> = {}): ProcessManagerConfig {
  return {
    dataDir: path.join(dir, 'data'),
    logDir: path.join(dir, 'logs'),
    ollama: fake(dir, 'ollama', '--port-env', 'OLLAMA_HOST'),
    collector: fake(dir, 'collector', '--port-env', 'COLLECTOR_PORT'),
    migrate: fake(dir, 'migrate', '--exit-after', '20'),
    server: fake(dir, 'server', '--port-env', 'SERVER_PORT'),
    killProcessGroup: true,
    handleParentSignals: false,
    healthIntervalMs: 20,
    stopTimeoutMs: 500,
    restart: { delaysMs: [20, 40, 80, 160, 320], maxAttempts: 5, windowMs: 60_000 },
    ...over,
  };
}

export interface RecordLine {
  name: string;
  event: string;
  pid: number;
  t: number;
  grandchild?: number;
  env?: Record<string, string | undefined>;
}

export function readRecord(dir: string): RecordLine[] {
  const f = path.join(dir, 'record.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RecordLine);
}

/** A zombie counts as dead: it has exited and only waits to be reaped. */
export function isAlive(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return stat !== '' && !stat.startsWith('Z');
  } catch {
    return false;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
