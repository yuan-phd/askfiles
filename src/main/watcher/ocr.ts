import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pdfPageImages } from '../sections/pdf-images.js';
import { hashFile } from './section-docs.js';
import type { OcrApi } from './types.js';

/** OCR text of one page; page 0 is text whose page is not known (the whole-file fallback). */
export interface OcrPage {
  page: number;
  text: string;
}

/** Bumped when the cached shape changes; older cache files are ignored and OCR runs again. */
const CACHE_VERSION = 2;

/**
 * Pages OCRed at the same time. The collector OCRs a whole PDF on min(CPUs, 4) workers
 * (upstream/collector/utils/OCRLoader, ocrPDF); one page per upload in parallel keeps that speed.
 */
export const OCR_CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length));

/**
 * The ocr hook of sectionSplitter for a PDF with no text layer. Only the collector OCRs (with the
 * seeded tesseract data and TARGET_OCR_LANG from the preset), so each page's images are taken out
 * of the PDF here (pdfPageImages), uploaded one by one as PNG without embedding, their text kept
 * and the stored copies deleted again; every section then carries its page. A page without images
 * or whose OCR finds nothing gives no text. Only when no page yields an image at all (a scan
 * stored in a way this reader does not decode) is the whole file sent, as before Session K, and its
 * text recorded as page 0. The result is cached by file hash, so a file is OCRed once.
 */
export function collectorOcr(o: {
  api: OcrApi;
  /** Folder for the cached text, for example <dataDir>/ocr-cache. */
  cacheDir: string;
  log?: (msg: string) => void;
  concurrency?: number;
}): (filePath: string) => Promise<OcrPage[]> {
  return async (filePath) => {
    const hash = await hashFile(filePath);
    const cached = path.join(o.cacheDir, `${hash}.pages.json`);
    try {
      const c = JSON.parse(fs.readFileSync(cached, 'utf8')) as { version?: number; pages?: OcrPage[] };
      if (c.version === CACHE_VERSION && Array.isArray(c.pages)) return c.pages;
    } catch {
      // Not cached yet, or unreadable: OCR again.
    }
    const name = path.basename(filePath, path.extname(filePath));
    const limit = o.concurrency ?? OCR_CONCURRENCY;
    // Text per page and image position; pages finish out of order when OCRed in parallel.
    const texts = new Map<number, string[]>();
    const running = new Set<Promise<void>>();
    const failures: unknown[] = [];
    let imagesSeen = 0;
    const t0 = Date.now();
    const ocrImage = async (page: number, i: number, png: Buffer) => {
      const r = await o.api.uploadImageForText(png, `${name}-page-${page}-${i + 1}.png`);
      // The copy is never embedded; leaving it would fill the server's document store.
      await o.api.purgeDocuments(r.locations);
      if (r.text.trim()) {
        const list = texts.get(page) ?? [];
        list[i] = r.text.trim();
        texts.set(page, list);
      }
    };
    for await (const p of pdfPageImages(fs.readFileSync(filePath))) {
      if (p.error) o.log?.(`OCR: page ${p.page} of ${filePath} unreadable: ${p.error}`);
      for (const [i, png] of p.images.entries()) {
        imagesSeen++;
        const task: Promise<void> = ocrImage(p.page, i, png)
          .catch((e: unknown) => void failures.push(e))
          .finally(() => running.delete(task));
        running.add(task);
        if (running.size >= limit) await Promise.race(running);
      }
      if (failures.length) break;
    }
    await Promise.all(running);
    if (failures.length) throw failures[0];
    const pages: OcrPage[] = [...texts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, list]) => ({ page, text: list.filter(Boolean).join('\n\n') }));
    if (imagesSeen) {
      o.log?.(`OCR: ${filePath}, ${pages.length} pages with text, ${imagesSeen} images in ${Date.now() - t0} ms`);
    } else {
      o.log?.(`OCR: no page images in ${filePath}, sending the whole file`);
      const { text, locations } = await o.api.uploadForText(filePath);
      await o.api.purgeDocuments(locations);
      if (text.trim()) pages.push({ page: 0, text });
    }
    if (!pages.length) throw new Error('OCR found no text');
    fs.mkdirSync(o.cacheDir, { recursive: true });
    const tmp = `${cached}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, pages }));
    fs.renameSync(tmp, cached);
    return pages;
  };
}
