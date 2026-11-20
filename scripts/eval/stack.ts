// Starts Ollama, collector and server for a run (managed mode) through the Session C process
// manager, from upstream-build/run: the patched copy of upstream/, which startManaged brings up to
// date first with scripts/build.sh (seconds when nothing changed). upstream/ is never touched. The
// data directory is kept between runs so the vector cache and earlier embeddings are reused.
import fs from 'node:fs';
import path from 'node:path';
import { ProcessManager } from '../../src/main/process-manager/index.js';
import { buildRunCopy, RUN_DIR } from '../lib/upstream-copy.mjs';
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
  if (!config.ollamaPort && !resolveOllama(config))
    return 'no ollama binary (set ollamaBin in the config, OLLAMA_BIN, or put ollama on PATH)';
  const server = path.join(root, RUN_DIR, 'server');
  for (const p of [
    path.join(server, 'node_modules'),
    path.join(root, RUN_DIR, 'collector', 'node_modules'),
    path.join(server, 'node_modules', 'prisma', 'build', 'index.js'),
  ]) {
    if (!fs.existsSync(p)) return `${path.relative(root, p)} is missing; run npm run build:upstream (docs/eval.md)`;
  }
  return null;
}

export async function startManaged(root: string, config: EvalConfig, logDir: string): Promise<Stack> {
  // A copy built from older sources or patches would answer with the wrong server code.
  buildRunCopy(root);
  const reason = managedSkipReason(root, config);
  if (reason) throw new Error(reason);
  const server = path.join(root, RUN_DIR, 'server');
  const collector = path.join(root, RUN_DIR, 'collector');
  const prismaCli = path.join(server, 'node_modules', 'prisma', 'build', 'index.js');

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
    ...(config.ollamaPort
      ? { externalOllamaPort: config.ollamaPort }
      : { ollama: { command: resolveOllama(config)!, args: ['serve'], cwd: config.dataDir } }),
    collector: { command: process.execPath, args: [path.join(collector, 'index.js')], cwd: collector },
    migrate: {
      command: process.execPath,
      args: [prismaCli, 'migrate', 'deploy', '--schema=./prisma/schema.prisma'],
      cwd: server,
    },
    server: { command: process.execPath, args: [path.join(server, 'index.js')], cwd: server, env },
    signals: { term: 'SIGTERM', kill: 'SIGKILL' },
    killProcessGroup: true,
    // run.ts handles SIGINT and SIGTERM itself, so it can stop the stack and write what it has.
    handleParentSignals: false,
    timeoutsMs: { ollama: 60_000, collector: 120_000, migrate: 180_000, server: 240_000 },
  });
  const status = await manager.start();
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
    },
  };
}
