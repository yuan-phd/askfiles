// The first run as src/main/app.ts wires it, without Electron: the real wizard against the real
// Ollama, server restart through the process manager, the All files library and API key through
// the API, setup marked complete in shell.json, no folder asked for. Then the library manager links
// one folder (a text PDF and a scanned PDF, OCRed page by page) and adds one file by copy, as the
// Add button does; all three become queryable and a question with the stored key gets an answer
// whose sources carry section titles. Needs RUN_INTEGRATION=1, Ollama with the test models, the
// upstream packages, and the compiled main process (npm run build:main).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowseIndex, chunkReader, followWatcher } from '../../src/main/browse/index.js';
import { FirstRun, type SetupEvent } from '../../src/main/first-run.js';
import { filesDir, LibraryManager } from '../../src/main/libraries.js';
import {
  deleteWorkspace,
  ensureApiKey,
  ensureLibrary,
  ensureWorkspace,
  workspaceNameOf,
} from '../../src/main/library.js';
import { OllamaClient } from '../../src/main/ollama/index.js';
import { loadPresets, workspaceSettings } from '../../src/main/presets/index.js';
import { isSetupComplete, loadShellState, saveShellState, type ShellState } from '../../src/main/shell-state.js';
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

describe.skipIf(reason !== null)('first run and libraries against the real stack', () => {
  it('sets up without a folder, then a linked folder and an added file are queryable', async () => {
    const up = upstream!;
    const presets = loadPresets(path.join(FIXTURES, 'presets-smoke.json'));
    const preset = presets.tiers[0]!;
    const serverUrl = () => `http://127.0.0.1:${up.manager.status().ports!.server}`;
    const ollamaUrl = () => `http://127.0.0.1:${up.manager.status().ports!.ollama}`;
    const dataDir = up.dataDir;
    const storageDir = up.storageDir;
    seedTesseractData({ langs: preset.ocrLanguages, storageDir });

    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-first-run-')));
    const folder = path.join(tmp, 'Documents');
    fs.mkdirSync(folder);
    for (const f of ['handbook.pdf', 'scanned.pdf']) fs.copyFileSync(path.join(FIXTURES, f), path.join(folder, f));
    const loose = path.join(tmp, 'Desktop', 'leave-policy-v2.md');
    fs.mkdirSync(path.dirname(loose));
    fs.copyFileSync(path.join(FIXTURES, 'eval-s', 'corpus', 'leave-policy-v2.md'), loose);

    let restarts = 0;
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
      setupLibrary: async ({ preset: p, storedKey }) => {
        const { apiKey } = await ensureApiKey(serverUrl(), storedKey);
        return { apiKey, workspaceSlug: await ensureLibrary(serverUrl(), apiKey, workspaceSettings(p)) };
      },
      log,
    });
    const events: SetupEvent[] = [];
    run.on('event', (e) => events.push(e));

    let manager: LibraryManager | null = null;
    try {
      const t0 = Date.now();
      const snap = await run.start();
      log(`first run ${snap.state} in ${Date.now() - t0} ms: ${snap.error ?? ''}`);
      expect(snap).toMatchObject({ state: 'done', error: null });
      expect(restarts).toBe(1);
      let state: ShellState = loadShellState(dataDir);
      expect(isSetupComplete(state)).toBe(true);
      expect(state.libraries.map((l) => [l.id, l.folders.length])).toEqual([['all-files', 0]]);
      expect(fs.statSync(path.join(dataDir, 'shell.json')).mode & 0o777).toBe(0o600);
      expect(events.filter((e) => e.type === 'setup').map((e) => (e as { state: string }).state)).toEqual([
        'models',
        'createLibrary',
        'done',
      ]);

      // The library got the preset's workspace settings.
      const base = serverUrl();
      const apiKey = state.apiKey!;
      const auth = { Authorization: `Bearer ${apiKey}` };
      const slug = state.libraries[0]!.workspaceSlug!;
      const ws = (await (await fetch(`${base}/api/v1/workspace/${slug}`, { headers: auth })).json()) as {
        workspace: { similarityThreshold: number; topN: number; chatMode: string }[];
      };
      expect(ws.workspace[0]).toMatchObject({ chatMode: 'query', topN: 4, similarityThreshold: 0 });

      // The library manager as src/main/app.ts builds it.
      const api = createLibraryApi({ baseUrl: serverUrl, apiKey });
      manager = new LibraryManager({
        dataDir,
        getState: () => state,
        setState: (s) => {
          saveShellState(dataDir, s);
          state = loadShellState(dataDir);
        },
        workspaces: {
          ensure: (id) => ensureWorkspace(serverUrl(), apiKey, workspaceNameOf(id), workspaceSettings(preset)),
          remove: (s) => deleteWorkspace(serverUrl(), apiKey, s),
        },
        removeDocuments: (f) => fs.rmSync(path.join(storageDir, 'documents', f), { recursive: true, force: true }),
        createWatcher: (o) =>
          new FolderWatcher({
            ...o,
            storageDir,
            api,
            splitter: sectionSplitter({
              maxChars: preset.chunkMaxChars,
              embeddingModel: preset.embeddingModel,
              ocr: collectorOcr({ api, cacheDir: path.join(dataDir, 'ocr-cache'), log }),
            }),
            watch: chokidarWatch,
            log: (m) => log(`[watcher] ${m}`),
          }),
        createBrowse: (o) => new BrowseIndex({ dir: o.dir, readChunk: chunkReader(storageDir), log }),
        followWatcher: (b, w) => followWatcher(b, w, log),
        onChange: () => {},
        onStatus: () => {},
        log,
      });
      await manager.start();
      expect(manager.isEmpty()).toBe(true);
      expect(await manager.addFolder(folder)).toEqual({ added: 1, skipped: [] });
      expect(await manager.addPaths([loose])).toEqual({ added: 1, skipped: [] });
      expect(fs.existsSync(path.join(filesDir(dataDir, 'all-files'), 'leave-policy-v2.md'))).toBe(true);

      const t1 = Date.now();
      for (;;) {
        const w = manager.watcherOf()!;
        await w.whenIdle();
        if (w.files().length === 3 || Date.now() - t1 > 600_000) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const w = manager.watcherOf()!;
      log(`library indexed in ${Date.now() - t1} ms`);
      expect(w.status().deadLetters).toEqual([]);
      const files = w.files();
      expect(files.map((f) => f.relPath).sort()).toEqual([
        path.join('Documents', 'handbook.pdf'),
        path.join('Documents', 'scanned.pdf'),
        'leave-policy-v2.md',
      ]);
      // Per-page OCR: each page of the scan is its own section with its real page number.
      const scanned = files.find((f) => f.path.endsWith('scanned.pdf'))!;
      expect(scanned.sections.map((x) => [x.sectionTitle, x.pageStart])).toEqual([
        ['Page 1', 1],
        ['Page 2', 2],
      ]);

      // Every file is queryable in the library's workspace: the linked PDF, the OCRed scan, the added file.
      const search = async (q: string) =>
        (
          (await (
            await fetch(`${base}/api/v1/workspace/${slug}/vector-search`, {
              method: 'POST',
              headers: { ...auth, 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: q, topN: 10, scoreThreshold: 0 }),
            })
          ).json()) as { results: { metadata: { url?: string; title?: string } }[] }
        ).results.map((r) => r.metadata.title);
      expect(await search('paid parental leave weeks')).toContain('leave-policy-v2.md');
      expect(await search('dinner refunded euros')).toContain('scanned.pdf');
      expect(await search('annual leave days per year')).toContain('handbook.pdf');

      const answer = (await (
        await fetch(`${base}/api/v1/workspace/${slug}/chat`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'How many days of paid annual leave does an employee get per year?',
            mode: 'query',
            sessionId: `first-run-it-${Date.now()}`,
          }),
        })
      ).json()) as { textResponse: string; sources: { title: string; sectionTitle?: string }[] };
      log(
        `answer: ${answer.textResponse.slice(0, 200)}; sources ${JSON.stringify(answer.sources.map((x) => [x.title, x.sectionTitle]))}`,
      );
      expect(answer.sources.length).toBeGreaterThan(0);
      expect(answer.sources.every((x) => typeof x.sectionTitle === 'string' && x.sectionTitle !== '')).toBe(true);

      // A second launch would go straight to the search page with the same key.
      expect((await ensureApiKey(base, apiKey)).created).toBe(false);
    } finally {
      await manager?.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 1_200_000);
});
