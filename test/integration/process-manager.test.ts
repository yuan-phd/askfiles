// Boots the real Ollama, collector and server through the process manager with every patch in
// patches/ applied. Needs RUN_INTEGRATION=1, an ollama binary on PATH (or OLLAMA_BIN), qwen3:0.6b
// pulled, and the upstream packages installed (scripts/install_pkgs.sh). Prints what it checks,
// including the ss output used for the bind check.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessManager } from '../../src/main/process-manager/index.js';
import { isAlive } from '../../src/main/process-manager/__fixtures__/helpers.js';
// @ts-expect-error plain JavaScript helper from Session B without type declarations
import { applyPatches, listPatches } from '../../scripts/lib/patches.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(ROOT, 'upstream', 'server');
const COLLECTOR = path.join(ROOT, 'upstream', 'collector');
const PRISMA_CLI = path.join(SERVER, 'node_modules', 'prisma', 'build', 'index.js');
const CHAT_MODEL = 'qwen3:0.6b';
const FOREIGN = 'https://evil.example';

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

const OLLAMA = process.env.OLLAMA_BIN ?? which('ollama');

function skipReason(): string | null {
  if (process.env.RUN_INTEGRATION !== '1') return 'RUN_INTEGRATION is not 1';
  if (!OLLAMA) return 'no ollama binary on PATH and OLLAMA_BIN is not set';
  for (const p of [path.join(SERVER, 'node_modules'), path.join(COLLECTOR, 'node_modules'), PRISMA_CLI]) {
    if (!fs.existsSync(p)) return `${path.relative(ROOT, p)} is missing; run scripts/install_pkgs.sh`;
  }
  return null;
}

const reason = skipReason();
// Written to stderr because vitest does not show console output from test collection.
if (reason) process.stderr.write(`[integration] process-manager skipped: ${reason}\n`);

const log = (msg: string) => console.log(`[integration] ${msg}`);

/** Every pid whose process group is one of `groups`. */
function groupMembers(groups: number[]): number[] {
  const out = execFileSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => pid && groups.includes(pgid!))
    .map(([pid]) => pid!);
}

interface Listener {
  local: string;
  pids: number[];
  line: string;
}

function listeners(): Listener[] {
  const out = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const cols = line.trim().split(/\s+/);
      const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
      return { local: cols[3]!, pids, line: line.trim() };
    });
}

function prismaGenerate(): void {
  const r = spawnSync(process.execPath, [PRISMA_CLI, 'generate', '--schema=./prisma/schema.prisma'], {
    cwd: SERVER,
    env: { ...process.env, CHECKPOINT_DISABLE: '1' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`prisma generate failed: ${r.stderr}`);
}

function stat(file: string): string {
  return fs.existsSync(file) ? `mtime ${fs.statSync(file).mtimeMs}` : 'absent';
}

describe.skipIf(reason !== null)('process manager with real ollama, collector and server', () => {
  let applied: string[] = [];
  let manager: ProcessManager | null = null;

  beforeAll(() => {
    // scripts/build.sh applies patches/ and then runs prisma generate. Do the same for this run;
    // patches that are already applied are left alone.
    const results = applyPatches({ repoRoot: ROOT, log }) as { name: string; action: string }[];
    applied = results.filter((r) => r.action === 'applied').map((r) => r.name);
    log(`patches applied for this run: ${applied.join(', ') || 'none'}; reverted afterwards`);
    // Patch 002 changes the datasource, which is baked into the generated client.
    if (applied.length) prismaGenerate();
  });

  afterAll(async () => {
    await manager?.stop();
    for (const name of [...applied].reverse()) {
      const r = spawnSync('git', ['apply', '--reverse', '--directory=upstream', path.join(ROOT, 'patches', name)], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      if (r.status !== 0) log(`could not revert ${name}: ${r.stderr}`);
    }
    if (applied.length) prismaGenerate();
  });

  it('boots, binds to 127.0.0.1, keeps data under the data directory, refuses foreign origins, stays offline, chats without thinking, and leaves no child', async () => {
    expect(listPatches(path.join(ROOT, 'patches'))).toHaveLength(7);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-it-'));
    const data = path.join(dir, 'data');
    const logs = path.join(dir, 'logs');
    const upstreamDb = path.join(SERVER, 'storage', 'anythingllm.db');
    const upstreamDbBefore = stat(upstreamDb);
    const m = new ProcessManager({
      dataDir: data,
      logDir: logs,
      // Default model directory, so the models pulled by the environment setup script are visible.
      ollama: { command: OLLAMA!, args: ['serve'], cwd: dir },
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
        // What the Session E presets will write into <dataDir>/server/.env.
        env: {
          LLM_PROVIDER: 'ollama',
          OLLAMA_MODEL_PREF: CHAT_MODEL,
          OLLAMA_MODEL_TOKEN_LIMIT: '4096',
          EMBEDDING_ENGINE: 'ollama',
          EMBEDDING_MODEL_PREF: 'all-minilm:latest',
          VECTOR_DB: 'lancedb',
          DEFAULT_REASONING_EFFORT: 'off',
        },
      },
      signals: { term: 'SIGTERM', kill: 'SIGKILL' },
      killProcessGroup: true,
      handleParentSignals: false,
      timeoutsMs: { ollama: 60_000, collector: 120_000, migrate: 180_000, server: 240_000 },
    });
    manager = m;
    m.on('state', (e) =>
      log(`${e.at} ${e.process} ${e.state}${e.port ? ` port ${e.port}` : ''}${e.detail ? ` (${e.detail})` : ''}`),
    );
    log(`data in ${data}, logs in ${logs}`);

    const t0 = Date.now();
    const status = await m.start();
    log(`running after ${Date.now() - t0} ms`);
    const ports = status.ports!;
    const base = `http://127.0.0.1:${ports.server}/api`;

    // 1. Health.
    const ping = await fetch(`${base}/ping`);
    const pingBody = await ping.text();
    log(`GET /api/ping -> ${ping.status} ${pingBody}`);
    expect(ping.status).toBe(200);

    // 2. Bind address of every socket the three process groups listen on.
    const groups = Object.values(status.processes).map((p) => p.pid!);
    const members = groupMembers(groups);
    const ours = listeners().filter((l) => l.pids.some((p) => members.includes(p)));
    log(`ss -ltnp, sockets owned by the three process groups:\n${ours.map((l) => l.line).join('\n')}`);
    expect(ours.length).toBeGreaterThan(0);
    for (const l of ours) expect(l.local).toMatch(/^127\.0\.0\.1:\d+$/);
    const locals = ours.map((l) => l.local);
    for (const p of Object.values(ports)) expect(locals).toContain(`127.0.0.1:${p}`);
    for (const p of Object.values(ports)) {
      for (const l of listeners().filter((l) => l.local.endsWith(`:${p}`))) expect(l.local).toBe(`127.0.0.1:${p}`);
    }

    // 3. Database under the data directory, nothing written next to the code.
    const db = path.join(data, 'storage', 'anythingllm.db');
    log(
      `database ${db}: ${stat(db)}; ${path.relative(ROOT, upstreamDb)}: before ${upstreamDbBefore}, after ${stat(upstreamDb)}`,
    );
    expect(fs.existsSync(db)).toBe(true);
    expect(stat(upstreamDb)).toBe(upstreamDbBefore);

    // 4. Foreign origins refused on server and collector; own origin and no origin allowed.
    const foreign = await fetch(`${base}/ping`, { headers: { Origin: FOREIGN } });
    const foreignAcao = foreign.headers.get('access-control-allow-origin');
    const preflight = await fetch(`${base}/system/generate-api-key`, {
      method: 'OPTIONS',
      headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'POST' },
    });
    const collectorForeign = await fetch(`http://127.0.0.1:${ports.collector}/accepts`, {
      headers: { Origin: FOREIGN },
    });
    const own = await fetch(`${base}/ping`, { headers: { Origin: `http://127.0.0.1:${ports.server}` } });
    log(
      `Origin ${FOREIGN}: server GET ${foreign.status} (allow-origin ${foreignAcao}), preflight ${preflight.status}, ` +
        `collector ${collectorForeign.status}; own origin ${own.status} (allow-origin ${own.headers.get('access-control-allow-origin')})`,
    );
    expect(foreign.status).toBe(403);
    expect(foreignAcao).toBeNull();
    expect(preflight.status).toBe(403);
    expect(collectorForeign.status).toBe(403);
    expect(own.status).toBe(200);
    expect(own.headers.get('access-control-allow-origin')).toBe(`http://127.0.0.1:${ports.server}`);

    // 5. Upload through the API: the file passes through the data directory's hotdir.
    const keyRes = await fetch(`${base}/system/generate-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'integration' }),
    });
    const key = ((await keyRes.json()) as { apiKey: { secret: string } }).apiKey.secret;
    const auth = { Authorization: `Bearer ${key}` };
    const form = new FormData();
    form.append(
      'file',
      new Blob(['AskFiles integration test document. The answer is 42.'], { type: 'text/plain' }),
      'it-note.txt',
    );
    const upload = (await (
      await fetch(`${base}/v1/document/upload`, { method: 'POST', headers: auth, body: form })
    ).json()) as {
      success: boolean;
      error: string | null;
      documents: { url: string; location: string }[];
    };
    const doc = upload.documents[0];
    log(`upload: success ${upload.success}, url ${doc?.url}, location ${doc?.location}`);
    expect(upload.success).toBe(true);
    expect(doc!.url).toBe(`file://${path.join(data, 'collector', 'hotdir', 'it-note.txt')}`);
    expect(fs.existsSync(path.join(data, 'storage', 'documents', doc!.location))).toBe(true);
    expect(fs.existsSync(path.join(COLLECTOR, 'hotdir', 'it-note.txt'))).toBe(false);

    // 5b. A settings change rewrites <dataDir>/server/.env, not upstream/server/.env.
    const upstreamEnv = path.join(SERVER, '.env');
    const upstreamEnvBefore = stat(upstreamEnv);
    const update = await fetch(`${base}/system/update-env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ OllamaLLMTokenLimit: '8192' }),
    });
    const dataEnv = fs.readFileSync(path.join(data, 'server', '.env'), 'utf8');
    log(
      `update-env -> ${update.status}; data .env has OLLAMA_MODEL_TOKEN_LIMIT='8192': ${dataEnv.includes("OLLAMA_MODEL_TOKEN_LIMIT='8192'")}; ` +
        `upstream/server/.env before ${upstreamEnvBefore}, after ${stat(upstreamEnv)}`,
    );
    expect(update.status).toBe(200);
    expect(dataEnv).toContain("OLLAMA_MODEL_TOKEN_LIMIT='8192'");
    expect(dataEnv).toMatch(/JWT_SECRET='/);
    expect(stat(upstreamEnv)).toBe(upstreamEnvBefore);

    // 6. /v1 chat with DEFAULT_REASONING_EFFORT=off: an answer without a think block. The control
    // sends an effort that resolves to none, so the model's default thinking stays on.
    const ws = (await (
      await fetch(`${base}/v1/workspace/new`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'integration' }),
      })
    ).json()) as { workspace: { slug: string } };
    const chat = async (extra: object) => {
      const t = Date.now();
      const r = await fetch(`${base}/v1/workspace/${ws.workspace.slug}/chat`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Answer in one word: what colour is the sky on a clear day?',
          mode: 'chat',
          reset: true,
          ...extra,
        }),
      });
      const body = (await r.json()) as { textResponse: string | null; error: string | null };
      return { status: r.status, ms: Date.now() - t, ...body };
    };
    const off = await chat({});
    log(
      `chat with default effort: ${off.status} in ${off.ms} ms, error ${off.error}, text ${JSON.stringify(off.textResponse)}`,
    );
    expect(off.status).toBe(200);
    expect(off.textResponse?.trim()).toBeTruthy();
    expect(off.textResponse).not.toMatch(/<think>/i);

    const control = await chat({ reasoningEffort: 'not-a-level' });
    log(
      `control chat with no effort applied: ${control.status} in ${control.ms} ms, starts ${JSON.stringify(control.textResponse?.slice(0, 60))}`,
    );
    expect(control.textResponse).toMatch(/<think>/i);

    const stream = await fetch(`${base}/v1/workspace/${ws.workspace.slug}/stream-chat`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Answer in one word: what is 2 plus 2?', mode: 'chat', reset: true }),
    });
    const streamed = (await stream.text())
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as { textResponse?: string })
      .map((e) => e.textResponse ?? '')
      .join('');
    log(`stream-chat with default effort: ${stream.status}, text ${JSON.stringify(streamed)}`);
    expect(streamed.trim()).toBeTruthy();
    expect(streamed).not.toMatch(/<think>/i);

    // 7. No boot fetch: the server log names neither host, and both syncs report disabled.
    const serverLog = fs.readFileSync(path.join(logs, 'server.log'), 'utf8');
    const hits = serverLog.split('\n').filter((l) => /models\.dev|raw\.githubusercontent\.com/.test(l));
    const disabled = serverLog.split('\n').filter((l) => /sync disabled/.test(l));
    const effort = serverLog.split('\n').filter((l) => /\[ReasoningEffort\]/.test(l));
    log(
      `server log: ${hits.length} lines name models.dev or raw.githubusercontent.com; disabled lines:\n${disabled.join('\n')}`,
    );
    log(`server log, reasoning effort lines:\n${effort.join('\n')}`);
    expect(hits).toEqual([]);
    expect(disabled.some((l) => l.includes('Remote pricing sync disabled'))).toBe(true);
    expect(disabled.some((l) => l.includes('Remote model map sync disabled'))).toBe(true);

    // 8. Clean stop.
    await m.stop();
    const left = members.filter(isAlive);
    log(
      `after stop: ${members.length} group members before, ${left.length} alive, ${groupMembers(groups).length} left in the groups`,
    );
    expect(left).toEqual([]);
    expect(groupMembers(groups)).toEqual([]);
  }, 600_000);
});
