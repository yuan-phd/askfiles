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
import { BrowseIndex, chunkReader, followWatcher } from '../../src/main/browse/index.js';
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
  it('OCRs a two-page scanned PDF page by page through the collector, with real page numbers', async () => {
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
    const images: { name: string; ms: number }[] = [];
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
            uploadImageForText: async (png, name) => {
              const t = Date.now();
              const r = await api.uploadImageForText(png, name);
              images.push({ name, ms: Date.now() - t });
              return r;
            },
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
      // Cost per page with the shipped tesseract data (eng and chi_sim, 4.0.0_best_int).
      log(`OCR per page: ${images.map((i) => `${i.name} ${i.ms} ms`).join(', ')}`);
      const [rec] = watcher.files();
      expect(rec!.sections.map((x) => [x.sectionTitle, x.pageStart, x.pageEnd])).toEqual([
        ['Page 1', 1, 1],
        ['Page 2', 2, 2],
      ]);
      const docs = rec!.sections.map(
        (x) =>
          JSON.parse(fs.readFileSync(path.join(up.storageDir, 'documents', x.location), 'utf8')) as {
            pageContent: string;
            pageStart: number;
          },
      );
      log(`OCR text: ${JSON.stringify(docs.map((d) => d.pageContent))}`);
      expect(docs.map((d) => d.pageStart)).toEqual([1, 2]);
      expect(docs[0]!.pageContent).toMatch(/second class/);
      expect(docs[0]!.pageContent).toMatch(/written approval from a director/);
      expect(docs[1]!.pageContent).toMatch(/Dinner is refunded up to 40 euros/);
      expect(docs[1]!.pageContent).not.toMatch(/second class/);
      expect(images.map((i) => i.name)).toEqual(['scanned-page-1-1.png', 'scanned-page-2-1.png']);
      expect(uploads).toHaveLength(0);
      // The collector copies of the uploads are gone again; only the section documents are embedded.
      const embedded = [...(await api.workspaceDocuments(ws.slug)).keys()].sort();
      expect(embedded).toEqual(rec!.sections.map((x) => x.location).sort());
    } finally {
      await watcher.stop();
    }
  }, 300_000);

  it('groups a heading shared by two dropped files in the browse heading index', async () => {
    const up = upstream!;
    const apiKey = await generateApiKey({ baseUrl: up.baseUrl, name: 'askfiles-browse-it' });
    const client = createClient({ baseUrl: up.baseUrl, apiKey });
    const ws = await client.createWorkspace('askfiles-browse-it', {
      chatMode: 'query',
      queryRefusalResponse: REFUSAL_TEXT,
    });
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-browse-it-')));
    const folder = path.join(tmp, 'Documents');
    fs.mkdirSync(folder);
    const api = createLibraryApi({ baseUrl: up.baseUrl, apiKey });
    const watcher = new FolderWatcher({
      root: folder,
      dataDir: path.join(tmp, 'shell'),
      storageDir: up.storageDir,
      workspaceSlug: ws.slug,
      api,
      splitter: sectionSplitter({ maxChars: 1000, embeddingModel: 'all-minilm:latest' }),
      watch: chokidarWatch,
      log: (m) => log(`[watcher] ${m}`),
    });
    const browse = new BrowseIndex({
      dir: path.join(tmp, 'shell', 'browse'),
      root: folder,
      readChunk: chunkReader(up.storageDir),
      log: (m) => log(`[browse] ${m}`),
    });
    followWatcher(browse, watcher, (m) => log(`[browse] ${m}`));
    await watcher.start();
    browse.sync(watcher.files());
    try {
      fs.writeFileSync(
        path.join(folder, 'policy-2025.md'),
        '# Leave policy 2025\n\nIntro.\n\n## 1. Annual Leave\n\nEmployees get 25 days.\n\n## 2. Sick leave\n\nCall in.\n',
      );
      fs.writeFileSync(
        path.join(folder, '制度-2026.md'),
        '# 休假制度\n\n总则。\n\n## 第二章 年假\n\n每年二十七天。\n\n## Annual leave：\n\nBook it in the portal.\n',
      );
      const grouped = await until('heading grouped', 120_000, async () => {
        const g = browse.headings({ key: 'annual leave' })[0];
        return g && g.documents === 2 ? g : null;
      });
      log(`heading grouped after ${grouped.elapsed} ms: ${JSON.stringify(grouped.value.entries.map((e) => e.title))}`);
      expect(grouped.value.entries.map((e) => [e.documentTitle, e.title, e.text])).toEqual([
        ['policy-2025.md', '1. Annual Leave', 'Employees get 25 days.'],
        ['制度-2026.md', 'Annual leave：', 'Book it in the portal.'],
      ]);
      // Every section the browse index shows was embedded in the server's workspace.
      await watcher.whenIdle();
      const embedded = await api.workspaceDocuments(ws.slug);
      const locations = watcher.files().flatMap((f) => f.sections.map((s) => s.location));
      expect(locations.every((l) => embedded.has(l))).toBe(true);
      expect(browse.search('二十七').groups.map((g) => g.document.title)).toEqual(['制度-2026.md']);
      expect(fs.readdirSync(path.join(tmp, 'shell', 'browse'))).toHaveLength(2);
    } finally {
      await watcher.stop();
    }
  }, 300_000);
});
