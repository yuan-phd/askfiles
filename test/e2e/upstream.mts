// Boots Ollama, collector and server for the integration tests through the Session C process
// manager, from upstream-build/run: the patched copy of upstream/ with its Prisma client, which
// test/integration/global-setup.mts builds once per run (scripts/build.sh). upstream/ is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The compiled build: Playwright's loader cannot map the manager's .js imports to its .ts sources.
import { ProcessManager } from '../../dist/main/process-manager/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(ROOT, 'upstream-build', 'run', 'server');
const COLLECTOR = path.join(ROOT, 'upstream-build', 'run', 'collector');
const PRISMA_CLI = path.join(SERVER, 'node_modules', 'prisma', 'build', 'index.js');

export const CHAT_MODEL = process.env.ASKFILES_TEST_CHAT_MODEL ?? 'qwen3:0.6b';
export const EMBED_MODEL = process.env.ASKFILES_TEST_EMBED_MODEL ?? 'all-minilm:latest';

const log = (msg: string) => console.log(`[e2e] ${msg}`);

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

/** Why the real upstream cannot run here, or null. */
export function skipReason(): string | null {
  if (!(process.env.OLLAMA_BIN ?? which('ollama'))) return 'no ollama binary on PATH and OLLAMA_BIN is not set';
  for (const p of [path.join(SERVER, 'node_modules'), path.join(COLLECTOR, 'node_modules'), PRISMA_CLI]) {
    if (!fs.existsSync(p)) return `${path.relative(ROOT, p)} is missing; run npm run build:upstream`;
  }
  return null;
}

export interface Upstream {
  baseUrl: string;
  storageDir: string;
  /** Root of the data directory: server/.env, ports.json, storage/. */
  dataDir: string;
  /** For tests that restart the stack, as the shell does after writing the .env. */
  manager: ProcessManager;
  stop: () => Promise<void>;
}

/** Starts the stack; allowedOrigins must hold the origin the page is served from (patch 005). */
export async function startUpstream({ allowedOrigins }: { allowedOrigins: string[] }): Promise<Upstream> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-e2e-'));
  const data = path.join(dir, 'data');
  const manager = new ProcessManager({
    dataDir: data,
    logDir: path.join(dir, 'logs'),
    allowedOrigins,
    // Default model directory, so the models pulled by the environment setup script are visible.
    ollama: { command: (process.env.OLLAMA_BIN ?? which('ollama'))!, args: ['serve'], cwd: dir },
    collector: { command: process.execPath, args: [path.join(COLLECTOR, 'index.js')], cwd: COLLECTOR },
    migrate: {
      command: process.execPath,
      args: [PRISMA_CLI, 'migrate', 'deploy', '--schema=./prisma/schema.prisma'],
      cwd: SERVER,
    },
    server: {
      command: process.execPath,
      args: [path.join(SERVER, 'index.js')],
      cwd: SERVER,
      // What the Session E presets will write into <dataDir>/server/.env, with the test models.
      env: {
        LLM_PROVIDER: 'ollama',
        OLLAMA_MODEL_PREF: CHAT_MODEL,
        OLLAMA_MODEL_TOKEN_LIMIT: '4096',
        EMBEDDING_ENGINE: 'ollama',
        EMBEDDING_MODEL_PREF: EMBED_MODEL,
        VECTOR_DB: 'lancedb',
        DEFAULT_REASONING_EFFORT: 'off',
        TARGET_OCR_LANG: 'eng,chi_sim',
      },
    },
    signals: { term: 'SIGTERM', kill: 'SIGKILL' },
    killProcessGroup: true,
    handleParentSignals: false,
    timeoutsMs: { ollama: 60_000, collector: 120_000, migrate: 180_000, server: 240_000 },
  });

  const status = await manager.start();
  const ports = status.ports!;
  const tags = (await (await fetch(`http://127.0.0.1:${ports.ollama}/api/tags`)).json()) as {
    models?: { name: string }[];
  };
  const names = (tags.models ?? []).map((m) => m.name);
  const stop = async () => {
    await manager.stop();
  };
  if (!names.includes(CHAT_MODEL) || !names.includes(EMBED_MODEL)) {
    await stop();
    throw new Error(`Ollama lacks ${CHAT_MODEL} or ${EMBED_MODEL} (has ${names.join(', ') || 'none'})`);
  }
  log(
    `upstream healthy: server ${ports.server}, collector ${ports.collector}, ollama ${ports.ollama}; files in ${dir}`,
  );
  return {
    baseUrl: `http://127.0.0.1:${ports.server}`,
    storageDir: path.join(data, 'storage'),
    dataDir: data,
    manager,
    stop,
  };
}
