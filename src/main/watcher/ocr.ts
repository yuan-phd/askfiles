import fs from 'node:fs';
import path from 'node:path';
import { hashFile } from './section-docs.js';
import type { OcrApi } from './types.js';

/**
 * The ocr hook of sectionSplitter for a PDF with no text layer, on the path the eval harness takes
 * (scripts/eval/library.ts, ocrText): only the collector OCRs, so the file is uploaded once
 * without embedding, its text kept and the stored copy deleted again. The text is cached by file
 * hash, so a file is OCRed once however often the split key changes. The splitter then treats it
 * as plain text, so every section records page 0, which the watcher stores as no page.
 * Languages are TARGET_OCR_LANG from the preset, read by the server on each upload.
 */
export function collectorOcr(o: {
  api: OcrApi;
  /** Folder for the cached text, for example <dataDir>/ocr-cache. */
  cacheDir: string;
  log?: (msg: string) => void;
}): (filePath: string) => Promise<string> {
  return async (filePath) => {
    const hash = await hashFile(filePath);
    const cached = path.join(o.cacheDir, `${hash}.txt`);
    if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
    o.log?.(`OCR through the collector: ${filePath}`);
    const { text, locations } = await o.api.uploadForText(filePath);
    // The copy is never embedded; leaving it would fill the server's document store.
    await o.api.purgeDocuments(locations);
    if (text.trim() === '') throw new Error('OCR found no text');
    fs.mkdirSync(o.cacheDir, { recursive: true });
    const tmp = `${cached}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, cached);
    return text;
  };
}
