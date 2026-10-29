// Pulls all-minilm through the wizard code path into a fresh, empty Ollama model folder, so the pull
// really downloads instead of finding the model the session already has. Needs RUN_INTEGRATION=1,
// an ollama binary on PATH (or OLLAMA_BIN) and network access to registry.ollama.ai. The upstream
// server is not started: a small stub answers the onboarding routes; Session C's integration test
// covers the real server.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelManager } from '../../src/main/models/index.js';
import { OllamaClient } from '../../src/main/ollama/index.js';
import { loadPresets, type PresetFile } from '../../src/main/presets/index.js';
import { Wizard, type WizardEvent } from '../../src/main/wizard/index.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MODEL = 'all-minilm';

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
const reason =
  process.env.RUN_INTEGRATION !== '1'
    ? 'RUN_INTEGRATION is not 1'
    : !OLLAMA
      ? 'no ollama binary on PATH and OLLAMA_BIN is not set'
      : null;
// Written to stderr because vitest does not show console output from test collection.
if (reason) process.stderr.write(`[integration] wizard skipped: ${reason}\n`);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not answer within ${ms} ms`);
}

describe.skipIf(reason !== null)('wizard against a real Ollama', () => {
  let dir: string;
  let ollama: ChildProcess;
  let ollamaUrl: string;
  let stub: http.Server;
  let stubUrl: string;
  let onboarded = false;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-wizard-int-'));
    const port = await freePort();
    ollamaUrl = `http://127.0.0.1:${port}`;
    ollama = spawn(OLLAMA!, ['serve'], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: path.join(dir, 'models') },
      stdio: ['ignore', fs.openSync(path.join(dir, 'ollama.log'), 'a'), fs.openSync(path.join(dir, 'ollama.log'), 'a')],
    });
    await waitFor(`${ollamaUrl}/api/tags`, 30_000);
    process.stderr.write(`[integration] wizard: ollama on ${ollamaUrl}, models in ${dir}/models\n`);

    stub = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/onboarding') onboarded = true;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ onboardingComplete: onboarded }));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    stubUrl = `http://127.0.0.1:${(stub.address() as net.AddressInfo).port}`;
  });

  afterAll(async () => {
    if (ollama && ollama.exitCode === null) {
      const exited = new Promise((r) => ollama.once('exit', r));
      ollama.kill('SIGTERM');
      await exited;
    }
    await new Promise((r) => stub?.close(r));
    // The pulled model is about 46 MB; do not leave one per run in the temp folder.
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pulls the model with progress up to 100 percent and it appears in /api/tags', async () => {
    const file = loadPresets(path.join(ROOT, 'config/presets.json'));
    const tier = { ...file.tiers[0]!, chatModel: MODEL, embeddingModel: MODEL };
    const presets: PresetFile = { ...file, tiers: [tier] };
    const client = new OllamaClient({ baseUrl: ollamaUrl });
    expect(await client.has(MODEL)).toBe(false);

    const envFile = path.join(dir, 'server', '.env');
    const wizard = new Wizard({
      presets,
      ollama: client,
      envFile,
      restartServer: async () => stubUrl,
      totalMemBytes: 8 * 1024 ** 3,
      log: (m) => process.stderr.write(`${m}\n`),
    });
    const progress: Extract<WizardEvent, { type: 'progress' }>[] = [];
    wizard.on('event', (e) => {
      if (e.type === 'progress') progress.push(e);
    });
    const snap = await wizard.start();

    expect(snap.error).toBeNull();
    expect(snap.state).toBe('done');
    const last = progress.at(-1)!;
    process.stderr.write(
      `[integration] wizard: ${progress.length} progress events, last ${last.status} ${last.completedBytes}/${last.totalBytes} bytes ${last.percent}%\n`,
    );
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.some((p) => p.status !== 'already installed')).toBe(true);
    expect(last).toMatchObject({ status: 'success', percent: 100 });
    expect(last.totalBytes).toBeGreaterThan(10_000_000);
    const percents = progress.map((p) => p.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));

    const tags = (await (await fetch(`${ollamaUrl}/api/tags`)).json()) as { models: { name: string }[] };
    expect(tags.models.map((m) => m.name)).toContain(`${MODEL}:latest`);
    expect(util.parseEnv(fs.readFileSync(envFile, 'utf8')).EMBEDDING_MODEL_PREF).toBe(MODEL);
    expect(onboarded).toBe(true);
  });

  it('model manager lists, refuses an embedding model as chat model, and deletes a copy', async () => {
    const client = new OllamaClient({ baseUrl: ollamaUrl });
    const copy = await fetch(`${ollamaUrl}/api/copy`, {
      method: 'POST',
      body: JSON.stringify({ source: `${MODEL}:latest`, destination: 'askfiles-copy:latest' }),
    });
    expect(copy.ok).toBe(true);
    const manager = new ModelManager({
      ollama: client,
      envFile: path.join(dir, 'server', '.env'),
      restartServer: async () => {},
    });

    expect((await manager.list()).map((m) => [m.name, m.role]).sort()).toEqual([
      // The test preset uses all-minilm as both chat and embedding model; chat is reported first.
      ['all-minilm:latest', 'chat'],
      ['askfiles-copy:latest', null],
    ]);
    await expect(manager.switchChatModel('askfiles-copy:latest')).rejects.toThrow(/cannot answer questions/);
    await manager.remove('askfiles-copy:latest');
    expect(await client.has('askfiles-copy:latest')).toBe(false);
  });
});
