// Drops a PDF into a watched temp folder and waits until the real server finds it through
// vector-search, then deletes it and waits until it is gone. Needs RUN_INTEGRATION=1, Ollama with
// the test models, the upstream packages, and the compiled main process (npm run build:main),
// because test/e2e/upstream.mts boots the stack from dist/main.
// The split is the real one (src/main/sections through sectionSplitter).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript client from Session D without type declarations
import { createClient, generateApiKey, normalizeSource, REFUSAL_TEXT } from '../../src/renderer/api/client.js';
import { seedTesseractData } from '../../src/main/tesseract.js';
import {
  chokidarWatch,
  collectorOcr,
  createLibraryApi,
  FolderWatcher,
  sectionSplitter,
} from '../../src/main/watcher/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PDF = path.join(ROOT, 'test', 'fixtures', 'handbook.pdf');
const SCANNED = path.join(ROOT, 'test', 'fixtures', 'scanned.pdf');
const log = (msg: string) => console.log(`[integration] ${msg}`);

function skipReason(): string | null {
  if (process.env.RUN_INTEGRATION !== '1') return 'RUN_INTEGRATION is not 1';
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'process-manager', 'index.js'))) {
    return 'dist/main is missing; run npm run build:main';
  }
  return null;
}

let reason = skipReason();
type Upstream = { baseUrl: string; storageDir: string; stop: () => Promise<void> };
let upstream: Upstream | null = null;
if (!reason) {
  const mod = (await import('../e2e/upstream.mts')) as {
    skipReason: () => string | null;
    startUpstream: (o: { allowedOrigins: string[] }) => Promise<Upstream>;
  };
  reason = mod.skipReason();
  if (!reason) {
    beforeAll(async () => {
      upstream = await mod.startUpstream({ allowedOrigins: [] });
    }, 600_000);
  }
}
if (reason) process.stderr.write(`[integration] watcher skipped: ${reason}\n`);

afterAll(async () => {
  await upstream?.stop();
});

async function until<T>(
  what: string,
  ms: number,
  probe: () => Promise<T | null>,
): Promise<{ value: T; elapsed: number }> {
  const t0 = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null) return { value, elapsed: Date.now() - t0 };
    if (Date.now() - t0 > ms) throw new Error(`${what} not within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(reason !== null)('folder watcher against the real server', () => {
  it('makes a dropped PDF queryable within 60 s and removes it on delete', async () => {
    const up = upstream!;
    const apiKey = await generateApiKey({ baseUrl: up.baseUrl, name: 'askfiles-watcher-it' });
    const client = createClient({ baseUrl: up.baseUrl, apiKey });
    const ws = await client.createWorkspace('askfiles-watcher-it', {
      chatMode: 'query',
      queryRefusalResponse: REFUSAL_TEXT,
    });

    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-watcher-it-')));
    const folder = path.join(tmp, 'Documents');
    fs.mkdirSync(folder);
    const watcher = new FolderWatcher({
      root: folder,
      dataDir: path.join(tmp, 'shell'),
      storageDir: up.storageDir,
      workspaceSlug: ws.slug,
      api: createLibraryApi({ baseUrl: up.baseUrl, apiKey }),
      // all-minilm reads 256 word pieces at most; a small maximum keeps each chunk within that.
      splitter: sectionSplitter({ maxChars: 1000, embeddingModel: 'all-minilm:latest' }),
      watch: chokidarWatch,
      log: (m) => log(`[watcher] ${m}`),
    });
    watcher.on('file', (e) => log(`file event ${JSON.stringify(e)}`));
    await watcher.start();

    try {
      const dropped = path.join(folder, 'handbook.pdf');
      const url = `file://${dropped}`;
      fs.copyFileSync(PDF, dropped);
      const search = async () =>
        ((await client.vectorSearch(ws.slug, 'annual leave days', { topN: 4, scoreThreshold: 0 })) as unknown[])
          .map(normalizeSource)
          .filter((s: { url: string }) => s.url === url);

      const found = await until('PDF queryable', 60_000, async () => {
        const hits = await search();
        return hits.length ? hits : null;
      });
      log(`queryable after ${found.elapsed} ms, ${found.value.length} hit(s)`);
      expect(found.elapsed).toBeLessThan(60_000);
      const [resolved] = watcher.resolveSources(found.value);
      const recs = watcher.files()[0]!.sections;
      log(
        `sections: ${recs.map((r) => `${r.sectionIndex}.${r.subIndex} ${r.sectionTitle} p${r.pageStart}`).join(' | ')}`,
      );
      expect(recs.length).toBeGreaterThan(1);
      const match = recs.find(
        (r) => r.sectionTitle === resolved.sectionTitle && r.sectionIndex === resolved.sectionIndex,
      );
      expect(match).toBeDefined();
      expect(resolved.page).toBeGreaterThanOrEqual(1);

      fs.rmSync(dropped);
      const gone = await until('PDF removed', 60_000, async () => ((await search()).length === 0 ? true : null));
      log(`removed after ${gone.elapsed} ms`);
      expect(JSON.parse(fs.readFileSync(path.join(tmp, 'shell', 'index.json'), 'utf8')).files).toEqual({});
    } finally {
      await watcher.stop();
    }
  }, 300_000);
  it('OCRs a scanned PDF through the collector with the seeded language data', async () => {
    const up = upstream!;
    // Node's fetch ignores the proxy here, so a download from the tesseract CDN would fail and
    // take the collector down (docs/upstream-analysis.md Q14): success means the seed was used.
    const seed = seedTesseractData({ langs: 'eng,chi_sim', storageDir: up.storageDir });
    log(`tesseract seed ${JSON.stringify(seed)}`);
    expect(seed.missing).toEqual([]);
    const apiKey = await generateApiKey({ baseUrl: up.baseUrl, name: 'askfiles-ocr-it' });
    const client = createClient({ baseUrl: up.baseUrl, apiKey });
    const ws = await client.createWorkspace('askfiles-ocr-it', {
      chatMode: 'query',
      queryRefusalResponse: REFUSAL_TEXT,
    });

    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-ocr-it-')));
    const folder = path.join(tmp, 'Documents');
    fs.mkdirSync(folder);
    fs.copyFileSync(SCANNED, path.join(folder, 'scanned.pdf'));
    const api = createLibraryApi({ baseUrl: up.baseUrl, apiKey });
    const uploads: string[] = [];
    const watcher = new FolderWatcher({
      root: folder,
      dataDir: path.join(tmp, 'shell'),
      storageDir: up.storageDir,
      workspaceSlug: ws.slug,
      api,
      splitter: sectionSplitter({
        maxChars: 1000,
        embeddingModel: 'all-minilm:latest',
        ocr: collectorOcr({
          api: {
            uploadForText: (f) => (uploads.push(f), api.uploadForText(f)),
            purgeDocuments: (l) => api.purgeDocuments(l),
          },
          cacheDir: path.join(tmp, 'shell', 'ocr-cache'),
          log: (m) => log(`[ocr] ${m}`),
        }),
      }),
      watch: chokidarWatch,
      log: (m) => log(`[watcher] ${m}`),
    });
    try {
      const t0 = Date.now();
      await watcher.start();
      await watcher.whenIdle();
      log(`scanned PDF done in ${Date.now() - t0} ms`);
      expect(watcher.status().deadLetters).toEqual([]);
      const [rec] = watcher.files();
      expect(rec!.sections).toHaveLength(1);
      expect(rec!.sections[0]).toMatchObject({ sectionTitle: 'scanned', pageStart: null, pageEnd: null });
      const doc = JSON.parse(
        fs.readFileSync(path.join(up.storageDir, 'documents', rec!.sections[0]!.location), 'utf8'),
      ) as { pageContent: string; pageStart: number };
      log(`OCR text: ${JSON.stringify(doc.pageContent)}`);
      expect(doc.pageStart).toBe(0);
      expect(doc.pageContent).toMatch(/second class/);
      expect(doc.pageContent).toMatch(/written approval from a director/);
      expect(uploads).toHaveLength(1);
      // The collector copy of the upload is gone again; only the section document is embedded.
      const embedded = [...(await api.workspaceDocuments(ws.slug)).keys()];
      expect(embedded).toEqual([rec!.sections[0]!.location]);
    } finally {
      await watcher.stop();
    }
  }, 300_000);
});
