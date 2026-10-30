import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeApi, manualWatch } from './__fixtures__/fakes.js';
import { collectorOcr } from './ocr.js';
import { sectionSplitter } from './splitter.js';
import type { IndexData, OcrApi } from './types.js';
import { FolderWatcher } from './watcher.js';

const SCANNED = path.resolve(import.meta.dirname, '../../../test/fixtures/scanned.pdf');
// Shaped like the collector's OCR text per page; test/integration/watcher.test.ts checks the real one.
const PAGE_TEXT: Record<number, string> = {
  1: ['Travel policy', '', 'Train journeys are booked in second class.'].join('\n'),
  2: ['Meals', '', 'Dinner is refunded up to 40 euros.'].join('\n'),
};
// A PDF with one page that has neither text nor images.
const BLANK_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-ocr-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Stands in for the collector: one upload per call, with the stored copy's location. */
function fakeCollector(pages: Record<number, string> = PAGE_TEXT, whole = 'Whole file text.') {
  const api = {
    images: [] as string[],
    uploads: [] as string[],
    purged: [] as string[][],
    async uploadForText(filePath: string) {
      api.uploads.push(filePath);
      return { text: whole, locations: [`custom-documents/${path.basename(filePath)}-abc.json`] };
    },
    async uploadImageForText(image: Buffer, fileName: string) {
      // Every page image arrives as a real PNG.
      expect(image.subarray(1, 4).toString('latin1')).toBe('PNG');
      api.images.push(fileName);
      const page = Number(/-page-(\d+)-/.exec(fileName)![1]);
      const text = pages[page] ?? '';
      return { text, locations: text ? [`custom-documents/${fileName}-abc.json`] : [] };
    },
    async purgeDocuments(locations: string[]) {
      api.purged.push(locations);
    },
  } satisfies OcrApi & Record<string, unknown>;
  return api;
}

describe('OCR of a PDF without a text layer, page by page', () => {
  it('sends each page image to the collector and splits by page with real page numbers', async () => {
    const api = fakeCollector();
    const splitter = sectionSplitter({
      maxChars: 2000,
      embeddingModel: 'all-minilm:latest',
      ocr: collectorOcr({ api, cacheDir: path.join(tmp, 'ocr-cache') }),
    });
    const chunks = await splitter.split(SCANNED);
    expect(api.images).toEqual(['scanned-page-1-1.png', 'scanned-page-2-1.png']);
    expect(api.uploads).toEqual([]);
    expect(api.purged).toEqual([
      ['custom-documents/scanned-page-1-1.png-abc.json'],
      ['custom-documents/scanned-page-2-1.png-abc.json'],
    ]);
    expect(chunks.map((c) => [c.sectionTitle, c.sectionIndex, c.pageStart, c.pageEnd, c.sectionPath])).toEqual([
      ['Page 1', 1, 1, 1, ['Page 1']],
      ['Page 2', 2, 2, 2, ['Page 2']],
    ]);
    expect(chunks[1]!.text).toContain('Dinner is refunded up to 40 euros.');
  });

  it('goes through the collector once per file content', async () => {
    const api = fakeCollector();
    const ocr = collectorOcr({ api, cacheDir: path.join(tmp, 'ocr-cache') });
    const pages = await ocr(SCANNED);
    expect(pages).toEqual([
      { page: 1, text: PAGE_TEXT[1] },
      { page: 2, text: PAGE_TEXT[2] },
    ]);
    const copy = path.join(tmp, 'renamed.pdf');
    fs.copyFileSync(SCANNED, copy);
    expect(await ocr(copy)).toEqual(pages);
    expect(api.images).toHaveLength(2);
    expect(fs.readdirSync(path.join(tmp, 'ocr-cache'))).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.pages\.json$/)]);
  });

  it('OCRs pages in parallel up to the limit and keeps them in page order', async () => {
    const api = fakeCollector();
    let inFlight = 0;
    let most = 0;
    const slow = {
      ...api,
      async uploadImageForText(image: Buffer, fileName: string) {
        inFlight++;
        most = Math.max(most, inFlight);
        // Page 1 finishes last.
        await new Promise((r) => setTimeout(r, fileName.includes('-page-1-') ? 80 : 10));
        inFlight--;
        return api.uploadImageForText(image, fileName);
      },
    };
    const pages = await collectorOcr({ api: slow, cacheDir: path.join(tmp, 'ocr-cache'), concurrency: 2 })(SCANNED);
    expect(most).toBe(2);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    const one = await collectorOcr({ api: slow, cacheDir: path.join(tmp, 'ocr-cache-1'), concurrency: 1 })(SCANNED);
    expect(one).toEqual(pages);
  });

  it('fails the file when a page upload fails, and caches nothing', async () => {
    const api = fakeCollector();
    const failing = {
      ...api,
      async uploadImageForText(image: Buffer, fileName: string) {
        if (fileName.includes('-page-2-')) throw new Error('POST /v1/document/upload failed (500): collector offline');
        return api.uploadImageForText(image, fileName);
      },
    };
    const ocr = collectorOcr({ api: failing, cacheDir: path.join(tmp, 'ocr-cache') });
    await expect(ocr(SCANNED)).rejects.toThrow('collector offline');
    expect(fs.existsSync(path.join(tmp, 'ocr-cache'))).toBe(false);
  });

  it('leaves out a page whose OCR finds nothing', async () => {
    const api = fakeCollector({ 2: PAGE_TEXT[2]! });
    const pages = await collectorOcr({ api, cacheDir: path.join(tmp, 'ocr-cache') })(SCANNED);
    expect(pages.map((p) => p.page)).toEqual([2]);
  });

  it('fails when no page has text and caches nothing', async () => {
    const api = fakeCollector({});
    const ocr = collectorOcr({ api, cacheDir: path.join(tmp, 'ocr-cache') });
    await expect(ocr(SCANNED)).rejects.toThrow('OCR found no text');
    expect(fs.existsSync(path.join(tmp, 'ocr-cache'))).toBe(false);
  });

  it('sends the whole file and records page 0 only when no page has an image', async () => {
    const file = path.join(tmp, 'drawn.pdf');
    fs.writeFileSync(file, BLANK_PDF);
    const api = fakeCollector();
    const splitter = sectionSplitter({
      maxChars: 2000,
      embeddingModel: 'all-minilm:latest',
      ocr: collectorOcr({ api, cacheDir: path.join(tmp, 'ocr-cache') }),
    });
    const chunks = await splitter.split(file);
    expect(api.images).toEqual([]);
    expect(api.uploads).toEqual([file]);
    expect(api.purged).toEqual([['custom-documents/drawn.pdf-abc.json']]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sectionTitle: 'drawn', sectionLevel: 0, pageStart: 0, pageEnd: 0 });
  });

  it('without an OCR hook the file fails instead of being indexed empty', async () => {
    const splitter = sectionSplitter({ maxChars: 2000, embeddingModel: 'all-minilm:latest' });
    await expect(splitter.split(SCANNED)).rejects.toThrow('no text layer and no OCR available');
  });

  it('the watcher records the page of each OCR section', async () => {
    const root = path.join(tmp, 'Documents');
    const dataDir = path.join(tmp, 'data');
    const storageDir = path.join(dataDir, 'storage');
    fs.mkdirSync(root);
    const file = path.join(root, 'scan.pdf');
    fs.copyFileSync(SCANNED, file);
    const collector = fakeCollector();
    const watcher = new FolderWatcher({
      root,
      dataDir,
      storageDir,
      workspaceSlug: 'library',
      api: fakeApi(storageDir),
      splitter: sectionSplitter({
        maxChars: 2000,
        embeddingModel: 'all-minilm:latest',
        ocr: collectorOcr({ api: collector, cacheDir: path.join(dataDir, 'ocr-cache') }),
      }),
      watch: manualWatch(),
      debounceMs: 10,
      stableMs: 10,
      log: () => {},
    });
    await watcher.start();
    await watcher.whenIdle();
    await watcher.stop();

    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8')) as IndexData;
    const sections = index.files[file]!.sections;
    expect(sections.map((s) => [s.sectionTitle, s.pageStart, s.pageEnd])).toEqual([
      ['Page 1', 1, 1],
      ['Page 2', 2, 2],
    ]);
    const doc = JSON.parse(fs.readFileSync(path.join(storageDir, 'documents', sections[1]!.location), 'utf8'));
    expect(doc).toMatchObject({ pageStart: 2, pageEnd: 2 });
    expect(doc.pageContent).toContain('Dinner is refunded up to 40 euros.');
    expect(collector.images).toEqual(['scan-page-1-1.png', 'scan-page-2-1.png']);
  });
});
