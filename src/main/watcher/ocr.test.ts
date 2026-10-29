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
// Shaped like the collector's OCR text for the fixture; test/integration/watcher.test.ts checks the real one.
const OCR_TEXT = [
  'Travel policy',
  '',
  'Train journeys are booked in second class.',
  '',
  'Flights need written approval from a director.',
].join('\n');

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-ocr-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Stands in for the collector: one upload per call, with the stored copy's location. */
function fakeCollector(text = OCR_TEXT): OcrApi & { uploads: string[]; purged: string[][] } {
  const api = {
    uploads: [] as string[],
    purged: [] as string[][],
    async uploadForText(filePath: string) {
      api.uploads.push(filePath);
      return { text, locations: [`custom-documents/${path.basename(filePath)}-abc.json`] };
    },
    async purgeDocuments(locations: string[]) {
      api.purged.push(locations);
    },
  };
  return api;
}

describe('OCR of a PDF without a text layer', () => {
  it('splits the collector text as plain text with page 0 and deletes the upload', async () => {
    const api = fakeCollector();
    const splitter = sectionSplitter({
      maxChars: 2000,
      embeddingModel: 'all-minilm:latest',
      ocr: collectorOcr({ api, cacheDir: path.join(tmp, 'ocr-cache') }),
    });
    const chunks = await splitter.split(SCANNED);
    expect(api.uploads).toEqual([SCANNED]);
    expect(api.purged).toEqual([['custom-documents/scanned.pdf-abc.json']]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sectionTitle: 'scanned', sectionIndex: 1, pageStart: 0, pageEnd: 0 });
    expect(chunks[0]!.text).toContain('Train journeys are booked in second class.');
  });

  it('goes through the collector once per file content', async () => {
    const api = fakeCollector();
    const ocr = collectorOcr({ api, cacheDir: path.join(tmp, 'ocr-cache') });
    expect(await ocr(SCANNED)).toBe(OCR_TEXT);
    const copy = path.join(tmp, 'renamed.pdf');
    fs.copyFileSync(SCANNED, copy);
    expect(await ocr(copy)).toBe(OCR_TEXT);
    expect(api.uploads).toEqual([SCANNED]);
    expect(fs.readdirSync(path.join(tmp, 'ocr-cache'))).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.txt$/)]);
  });

  it('fails on empty OCR text and caches nothing', async () => {
    const api = fakeCollector('  \n ');
    const ocr = collectorOcr({ api, cacheDir: path.join(tmp, 'ocr-cache') });
    await expect(ocr(SCANNED)).rejects.toThrow('OCR found no text');
    expect(api.purged).toHaveLength(1);
    expect(fs.existsSync(path.join(tmp, 'ocr-cache'))).toBe(false);
  });

  it('without an OCR hook the file fails instead of being indexed empty', async () => {
    const splitter = sectionSplitter({ maxChars: 2000, embeddingModel: 'all-minilm:latest' });
    await expect(splitter.split(SCANNED)).rejects.toThrow('no text layer and no OCR available');
  });

  it('the watcher indexes a scanned PDF with no page recorded', async () => {
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
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ sectionTitle: 'scan', pageStart: null, pageEnd: null });
    const doc = JSON.parse(fs.readFileSync(path.join(storageDir, 'documents', sections[0]!.location), 'utf8'));
    expect(doc).toMatchObject({ pageStart: 0, pageEnd: 0 });
    expect(doc.pageContent).toContain('Flights need written approval from a director.');
    expect(collector.uploads).toEqual([file]);
  });
});
