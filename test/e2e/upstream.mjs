// Minimal launcher for the upstream collector and server, used only by the e2e tests.
// Session C's process manager replaces this once it is merged.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { promisify } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const SERVER_DIR = join(ROOT, "upstream/server");
const COLLECTOR_DIR = join(ROOT, "upstream/collector");

export const CHAT_MODEL = process.env.ASKFILES_TEST_CHAT_MODEL || "qwen3:0.6b";
export const EMBED_MODEL = process.env.ASKFILES_TEST_EMBED_MODEL || "all-minilm:latest";

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function ollamaAvailable(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/api/tags`);
    if (!r.ok) return false;
    const { models = [] } = await r.json();
    const names = models.map((m) => m.name);
    return names.includes(CHAT_MODEL) && names.includes(EMBED_MODEL);
  } catch {
    return false;
  }
}

/**
 * Starts collector and server against a fresh storage directory.
 * Returns { baseUrl, stop, logDir } or throws with a reason.
 */
export async function startUpstream({ ollamaUrl = "http://127.0.0.1:11434" } = {}) {
  if (!existsSync(join(SERVER_DIR, "node_modules")) || !existsSync(join(COLLECTOR_DIR, "node_modules"))) {
    throw new Error("upstream server or collector dependencies are not installed");
  }

  // In production mode the server writes uploads to STORAGE_DIR/../../collector/hotdir
  // while the collector reads its own hotdir, so the temp layout mirrors that path
  // with a symlink back to the real hotdir.
  const base = mkdtempSync(join(tmpdir(), "askfiles-e2e-"));
  const storage = join(base, "server", "storage");
  mkdirSync(storage, { recursive: true });
  mkdirSync(join(base, "collector"), { recursive: true });
  symlinkSync(join(COLLECTOR_DIR, "hotdir"), join(base, "collector", "hotdir"));

  const [serverPort, collectorPort] = [await freePort(), await freePort()];
  const env = {
    ...process.env,
    NODE_ENV: "production",
    STORAGE_DIR: storage,
    SERVER_PORT: String(serverPort),
    COLLECTOR_PORT: String(collectorPort),
    JWT_SECRET: "e2e-jwt-secret-not-for-production",
    SIG_KEY: "e2e-sig-key-0123456789abcdefghijklmnop",
    SIG_SALT: "e2e-sig-salt-0123456789abcdefghijklmno",
    LLM_PROVIDER: "ollama",
    OLLAMA_BASE_PATH: ollamaUrl,
    OLLAMA_MODEL_PREF: CHAT_MODEL,
    OLLAMA_MODEL_TOKEN_LIMIT: "4096",
    EMBEDDING_ENGINE: "ollama",
    EMBEDDING_BASE_PATH: ollamaUrl,
    EMBEDDING_MODEL_PREF: EMBED_MODEL,
    EMBEDDING_MODEL_MAX_CHUNK_LENGTH: "1000",
    VECTOR_DB: "lancedb",
    DISABLE_TELEMETRY: "true",
  };

  // The Prisma schema hardcodes the SQLite path to upstream/server/storage, so the database
  // is shared across runs; tests create uniquely named workspaces to stay independent.
  await promisify(execFile)(join(SERVER_DIR, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: SERVER_DIR,
    env,
  });

  const children = [];
  const launch = (name, cwd) => {
    const log = openSync(join(base, `${name}.log`), "a");
    const child = spawn(process.execPath, ["index.js"], { cwd, env, stdio: ["ignore", log, log] });
    children.push(child);
    return child;
  };
  launch("collector", COLLECTOR_DIR);
  if (!(await waitFor(`http://127.0.0.1:${collectorPort}/`, 60_000))) {
    children.forEach((c) => c.kill("SIGKILL"));
    throw new Error(`collector did not become healthy; see ${base}/collector.log`);
  }
  launch("server", SERVER_DIR);
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  if (!(await waitFor(`${baseUrl}/api/ping`, 90_000))) {
    children.forEach((c) => c.kill("SIGKILL"));
    throw new Error(`server did not become healthy; see ${base}/server.log`);
  }
  console.log(`[e2e] upstream healthy on ${serverPort}, collector ${collectorPort}, logs in ${base}`);

  const stop = async () => {
    for (const c of children) c.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  };
  return { baseUrl, stop, logDir: base };
}
