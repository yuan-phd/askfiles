import path from 'node:path';

export type ProcessName = 'ollama' | 'collector' | 'server';
export type StepName = ProcessName | 'migrate';

export type ProcessState = 'starting' | 'healthy' | 'crashed' | 'restarting' | 'stopped' | 'failed';

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Extra variables for this process. Values the manager owns (ports, host, storage) still win. */
  env?: Record<string, string>;
}

export interface ProcessManagerConfig {
  /** Root of the app data, for example ~/Library/Application Support/AskFiles. */
  dataDir: string;
  /** STORAGE_DIR for server and collector. Default <dataDir>/storage. */
  storageDir?: string;
  logDir: string;
  /** Default 127.0.0.1. Every child binds here and every health check goes here. */
  host?: string;
  /**
   * Browser origins allowed to call server and collector besides the server's own origin, for
   * example the origin of the shell's renderer pages. Any other Origin header gets 403 (patch 005).
   */
  allowedOrigins?: string[];
  /** Environment inherited by every child. Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  ollama: CommandSpec;
  collector: CommandSpec;
  /** Runs to completion before the server starts, normally prisma migrate deploy. */
  migrate: CommandSpec;
  server: CommandSpec;
  signals?: { term?: NodeJS.Signals; kill?: NodeJS.Signals };
  /**
   * Spawn each child as a process group leader and signal the whole group, so helpers such as
   * the ollama runner die with their parent. Needs POSIX process groups; the caller decides.
   */
  killProcessGroup?: boolean;
  timeoutsMs?: Partial<Record<StepName, number>>;
  /** Wait after the term signal before the kill signal. Default 5000. */
  stopTimeoutMs?: number;
  restart?: { delaysMs?: number[]; maxAttempts?: number; windowMs?: number };
  healthIntervalMs?: number;
  /** Rotate a log file when it would grow past this size. Default 5 MB. */
  logMaxBytes?: number;
  /** Stop the children when the parent gets one of parentSignals or exits. Default true. */
  handleParentSignals?: boolean;
  /** Default SIGINT and SIGTERM. */
  parentSignals?: NodeJS.Signals[];
}

export interface ResolvedConfig {
  dataDir: string;
  storageDir: string;
  logDir: string;
  envFile: string;
  hotDir: string;
  collectorTmpDir: string;
  databaseFile: string;
  host: string;
  allowedOrigins: string[];
  baseEnv: NodeJS.ProcessEnv;
  specs: Record<StepName, CommandSpec>;
  signals: { term: NodeJS.Signals; kill: NodeJS.Signals };
  killProcessGroup: boolean;
  timeoutsMs: Record<StepName, number>;
  stopTimeoutMs: number;
  restart: { delaysMs: number[]; maxAttempts: number; windowMs: number };
  healthIntervalMs: number;
  logMaxBytes: number;
  handleParentSignals: boolean;
  parentSignals: NodeJS.Signals[];
}

export function resolveConfig(c: ProcessManagerConfig): ResolvedConfig {
  const delaysMs = c.restart?.delaysMs ?? [1000, 2000, 4000, 8000, 16000];
  if (delaysMs.length === 0) throw new Error('restart.delaysMs must not be empty');
  const storageDir = c.storageDir ?? path.join(c.dataDir, 'storage');
  return {
    dataDir: c.dataDir,
    storageDir,
    logDir: c.logDir,
    envFile: path.join(c.dataDir, 'server', '.env'),
    hotDir: path.join(c.dataDir, 'collector', 'hotdir'),
    collectorTmpDir: path.join(c.dataDir, 'collector', 'tmp'),
    databaseFile: path.join(storageDir, 'anythingllm.db'),
    host: c.host ?? '127.0.0.1',
    allowedOrigins: c.allowedOrigins ?? [],
    baseEnv: c.baseEnv ?? process.env,
    specs: { ollama: c.ollama, collector: c.collector, migrate: c.migrate, server: c.server },
    signals: { term: c.signals?.term ?? 'SIGTERM', kill: c.signals?.kill ?? 'SIGKILL' },
    killProcessGroup: c.killProcessGroup ?? false,
    timeoutsMs: {
      ollama: 30_000,
      collector: 60_000,
      migrate: 120_000,
      server: 120_000,
      ...c.timeoutsMs,
    },
    stopTimeoutMs: c.stopTimeoutMs ?? 5000,
    restart: {
      delaysMs,
      maxAttempts: c.restart?.maxAttempts ?? 5,
      windowMs: c.restart?.windowMs ?? 10 * 60_000,
    },
    healthIntervalMs: c.healthIntervalMs ?? 250,
    logMaxBytes: c.logMaxBytes ?? 5 * 1024 * 1024,
    handleParentSignals: c.handleParentSignals ?? true,
    parentSignals: c.parentSignals ?? ['SIGINT', 'SIGTERM'],
  };
}
