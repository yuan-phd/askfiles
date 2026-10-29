// The first run as src/main/app.ts wires it, without Electron: the real wizard against the real
// Ollama, server restart through the process manager, library and API key through the API, the
// folder watcher with OCR, and setup marked complete in shell.json. Then a question with the
// stored key gets an answer whose sources carry section titles. Needs RUN_INTEGRATION=1, Ollama
// with the test models, the upstream packages, and the compiled main process (npm run build:main).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirstRun, type SetupEvent } from '../../src/main/first-run.js';
import { ensureApiKey, ensureLibrary } from '../../src/main/library.js';
import { OllamaClient } from '../../src/main/ollama/index.js';
import { loadPresets, workspaceSettings } from '../../src/main/presets/index.js';
import { isSetupComplete, loadShellState, saveShellState } from '../../src/main/shell-state.js';
import { seedTesseractData } from '../../src/main/tesseract.js';
import {
  chokidarWatch,
  collectorOcr,
  createLibraryApi,
  FolderWatcher,
  sectionSplitter,
} from '../../src/main/watcher/index.js';
import { Wizard } from '../../src/main/wizard/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const log = (msg: string) => console.log(`[integration] ${msg}`);

function skipReason(): string | null {
  if (process.env.RUN_INTEGRATION !== '1') return 'RUN_INTEGRATION is not 1';
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'process-manager', 'index.js'))) {
    return 'dist/main is missing; run npm run build:main';
  }
  return null;
}

type Upstream = Awaited<ReturnType<typeof import('../e2e/upstream.mts').startUpstream>>;
let reason = skipReason();
let upstream: Upstream | null = null;
if (!reason) {
  const mod = await import('../e2e/upstream.mts');
  reason = mod.skipReason();
  if (!reason) {
    beforeAll(async () => {
      upstream = await mod.startUpstream({ allowedOrigins: [] });
    }, 600_000);
  }
}
if (reason) process.stderr.write(`[integration] first run skipped: ${reason}\n`);

afterAll(async () => {
  await upstream?.stop();
});

describe.skipIf(reason !== null)('first run against the real stack', () => {
  it('sets up models, library, key and index, then answers with section sources', async () => {
    const up = upstream!;
    const presets = loadPresets(path.join(FIXTURES, 'presets-smoke.json'));
    const serverUrl = () => `http://127.0.0.1:${up.manager.status().ports!.server}`;
    const ollamaUrl = () => `http://127.0.0.1:${up.manager.status().ports!.ollama}`;
    const dataDir = up.dataDir;
    const storageDir = up.storageDir;
    seedTesseractData({ langs: presets.tiers[0]!.ocrLanguages, storageDir });

    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-first-run-')));
    const folder = path.join(tmp, 'Documents');
    fs.mkdirSync(folder);
    for (const f of ['handbook.pdf', 'scanned.pdf']) fs.copyFileSync(path.join(FIXTURES, f), path.join(folder, f));

    let restarts = 0;
    let watcher: FolderWatcher | null = null;
    const wizard = new Wizard({
      presets,
      ollama: new OllamaClient({ baseUrl: ollamaUrl() }),
      envFile: path.join(dataDir, 'server', '.env'),
      restartServer: async () => {
        restarts++;
        await up.manager.stop();
        await up.manager.start();
        return serverUrl();
      },
      log,
    });
    const run = new FirstRun({
      wizard,
      loadState: () => loadShellState(dataDir),
      saveState: (s) => saveShellState(dataDir, s),
      presetFolder: folder,
      isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
      setupLibrary: async ({ preset, storedKey }) => {
        const { apiKey } = await ensureApiKey(serverUrl(), storedKey);
        return { apiKey, workspaceSlug: await ensureLibrary(serverUrl(), apiKey, workspaceSettings(preset)) };
      },
      startWatcher: async ({ folder: root, workspaceSlug, apiKey, preset }) => {
        const api = createLibraryApi({ baseUrl: serverUrl, apiKey });
        watcher = new FolderWatcher({
          root,
          dataDir,
          storageDir,
          workspaceSlug,
          api,
          splitter: sectionSplitter({
            maxChars: preset.chunkMaxChars,
            embeddingModel: preset.embeddingModel,
            ocr: collectorOcr({ api, cacheDir: path.join(dataDir, 'ocr-cache'), log }),
          }),
          watch: chokidarWatch,
          log: (m) => log(`[watcher] ${m}`),
        });
        await watcher.start();
        return watcher;
      },
      log,
    });
    const events: SetupEvent[] = [];
    run.on('event', (e) => events.push(e));

    try {
      const t0 = Date.now();
      const snap = await run.start();
      log(`first run ${snap.state} in ${Date.now() - t0} ms: ${snap.error ?? ''}`);
      expect(snap).toMatchObject({ state: 'done', folder, error: null });
      expect(restarts).toBe(1);
      const state = loadShellState(dataDir);
      expect(isSetupComplete(state)).toBe(true);
      expect(fs.statSync(path.join(dataDir, 'shell.json')).mode & 0o777).toBe(0o600);
      expect(events.filter((e) => e.type === 'setup').map((e) => (e as { state: string }).state)).toEqual([
        'models',
        'chooseFolder',
        'chooseFolder',
        'createLibrary',
        'indexing',
        'done',
      ]);

      const files = watcher!.files();
      expect(files.map((f) => path.basename(f.path)).sort()).toEqual(['handbook.pdf', 'scanned.pdf']);
      expect(watcher!.status().deadLetters).toEqual([]);

      // The library got the preset's workspace settings.
      const base = serverUrl();
      const ws = (await (
        await fetch(`${base}/api/v1/workspace/${state.workspaceSlug}`, {
          headers: { Authorization: `Bearer ${state.apiKey}` },
        })
      ).json()) as { workspace: { similarityThreshold: number; topN: number; chatMode: string }[] };
      expect(ws.workspace[0]).toMatchObject({ chatMode: 'query', topN: 4, similarityThreshold: 0 });

      const answer = (await (
        await fetch(`${base}/api/v1/workspace/${state.workspaceSlug}/chat`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'How many days of paid annual leave does an employee get per year?',
            mode: 'query',
            sessionId: `first-run-it-${Date.now()}`,
          }),
        })
      ).json()) as { textResponse: string; sources: { title: string; sectionTitle?: string }[] };
      log(
        `answer: ${answer.textResponse.slice(0, 200)}; sources ${JSON.stringify(answer.sources.map((s) => [s.title, s.sectionTitle]))}`,
      );
      expect(answer.sources.length).toBeGreaterThan(0);
      expect(answer.sources.every((s) => typeof s.sectionTitle === 'string' && s.sectionTitle !== '')).toBe(true);

      // A second launch would go straight to the search page with the same key.
      expect((await ensureApiKey(base, state.apiKey)).created).toBe(false);
    } finally {
      await (watcher as FolderWatcher | null)?.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 900_000);
});
