// Starts Ollama, collector and server for a run (managed mode) through the Session C process
// manager, with every patch in patches/ applied for the run and reverted afterwards, as
// test/e2e/upstream.mts does. The data directory is kept between runs so the vector cache and
// earlier embeddings are reused.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ProcessManager } from '../../src/main/process-manager/index.js';
import { applyPatches } from '../lib/patches.mjs';
import type { EvalConfig } from './config.js';

export interface Stack {
  baseUrl: string;
  storageDir: string;
  /** Ollama base URL, used to read the model tags actually served. */
  ollamaUrl: string;
  stop: () => Promise<void>;
}

const log = (msg: string) => console.log(`[eval] ${msg}`);

function which(bin: string): string | null {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

export function resolveOllama(config: EvalConfig): string | null {
  if (config.ollamaBin) return config.ollamaBin.includes('/') ? config.ollamaBin : which(config.ollamaBin);
  return process.env.OLLAMA_BIN ?? which('ollama');
}

/** Why managed mode cannot run here, or null. */
export function managedSkipReason(root: string, config: EvalConfig): string | null {
  if (!resolveOllama(config))
    return 'no ollama binary (set ollamaBin in the config, OLLAMA_BIN, or put ollama on PATH)';
  const server = path.join(root, 'upstream', 'server');
  for (const p of [
    path.join(server, 'node_modules'),
    path.join(root, 'upstream', 'collector', 'node_modules'),
    path.join(server, 'node_modules', 'prisma', 'build', 'index.js'),
  ]) {
    if (!fs.existsSync(p)) return `${path.relative(root, p)} is missing; install the upstream packages (docs/eval.md)`;
  }
  return null;
}

function prismaGenerate(server: string, prismaCli: string): void {
  const r = spawnSync(process.execPath, [prismaCli, 'generate', '--schema=./prisma/schema.prisma'], {
    cwd: server,
    env: { ...process.env, CHECKPOINT_DISABLE: '1' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`prisma generate failed: ${r.stderr}`);
}

export async function startManaged(root: string, config: EvalConfig, logDir: string): Promise<Stack> {
  const reason = managedSkipReason(root, config);
  if (reason) throw new Error(reason);
  const server = path.join(root, 'upstream', 'server');
  const collector = path.join(root, 'upstream', 'collector');
  const prismaCli = path.join(server, 'node_modules', 'prisma', 'build', 'index.js');

  const results = applyPatches({ repoRoot: root, log }) as { name: string; action: string }[];
  const applied = results.filter((r) => r.action === 'applied').map((r) => r.name);
  // Patch 002 changes the datasource, which is baked into the generated client.
  if (applied.length) prismaGenerate(server, prismaCli);
  const revert = () => {
    for (const name of [...applied].reverse()) {
      const r = spawnSync('git', ['apply', '--reverse', '--directory=upstream', path.join(root, 'patches', name)], {
        cwd: root,
        encoding: 'utf8',
      });
      if (r.status !== 0) log(`could not revert ${name}: ${r.stderr}`);
    }
    if (applied.length) prismaGenerate(server, prismaCli);
  };

  const env: Record<string, string> = {
    LLM_PROVIDER: 'ollama',
    OLLAMA_MODEL_PREF: config.chatModel,
    EMBEDDING_ENGINE: 'ollama',
    EMBEDDING_MODEL_PREF: config.embeddingModel,
    // Upstream splits at min(text_splitter_chunk_size, this). The harness already cut every chunk
    // to chunkMax, so upstream must not cut again.
    EMBEDDING_MODEL_MAX_CHUNK_LENGTH: String(config.chunkMax),
    VECTOR_DB: 'lancedb',
    DEFAULT_REASONING_EFFORT: 'off',
  };
  if (config.contextTokens) env.OLLAMA_MODEL_TOKEN_LIMIT = String(config.contextTokens);

  fs.mkdirSync(config.dataDir, { recursive: true });
  const manager = new ProcessManager({
    dataDir: config.dataDir,
    logDir,
    // Default model directory, so models pulled with the ollama CLI are visible.
    ollama: { command: resolveOllama(config)!, args: ['serve'], cwd: config.dataDir },
    collector: { command: process.execPath, args: [path.join(collector, 'index.js')], cwd: collector },
    migrate: {
      command: process.execPath,
      args: [prismaCli, 'migrate', 'deploy', '--schema=./prisma/schema.prisma'],
      cwd: server,
    },
    server: { command: process.execPath, args: [path.join(server, 'index.js')], cwd: server, env },
    signals: { term: 'SIGTERM', kill: 'SIGKILL' },
    killProcessGroup: true,
    // run.ts handles SIGINT and SIGTERM itself, so it can revert the patches after stopping.
    handleParentSignals: false,
    timeoutsMs: { ollama: 60_000, collector: 120_000, migrate: 180_000, server: 240_000 },
  });
  let status;
  try {
    status = await manager.start();
  } catch (e) {
    revert();
    throw e;
  }
  const ports = status.ports!;
  log(
    `stack healthy: server ${ports.server}, collector ${ports.collector}, ollama ${ports.ollama}; data in ${config.dataDir}`,
  );
  return {
    baseUrl: `http://127.0.0.1:${ports.server}`,
    storageDir: path.join(config.dataDir, 'storage'),
    ollamaUrl: `http://127.0.0.1:${ports.ollama}`,
    stop: async () => {
      await manager.stop();
      revert();
    },
  };
}
