import path from 'node:path';
import {
  chunkSections,
  isGarbled,
  pageQuality,
  paragraphs,
  readableLength,
  parseFile,
  splitKeyOf,
  SPLITTER_VERSION,
  docTitleOf,
  type Chunk,
  type IndexingOptions,
  type ParsedDocument,
} from '../sections/index.js';
import type { Section } from '../sections/index.js';
import type { OcrPage } from './ocr.js';
import type { SplitStats, Splitter } from './types.js';

/** Same strategy name the evaluation harness uses (scripts/eval/config.ts), so split keys match. */
export const SPLIT_STRATEGY = 'heading';

/**
 * Sections of OCR text: OCR gives no heading information, so one section per page titled Page N,
 * the same as a PDF with text but no outline. Text of unknown page (page 0) is one section titled
 * by the file name.
 */
export function sectionsFromOcr(pages: OcrPage[], fileName: string): Section[] {
  return pages
    .map((p) =>
      p.page > 0
        ? { title: `Page ${p.page}`, level: 1, blocks: paragraphs(p.text, p.page) }
        : { title: docTitleOf(fileName), level: 0, blocks: paragraphs(p.text, 0) },
    )
    .filter((s) => s.blocks.length);
}

/** OCR of a whole scanned PDF, or with pages of those pages only (collectorOcr). */
export type OcrFn = (filePath: string, pages?: number[]) => Promise<OcrPage[]>;

/**
 * The replacement guard: a page's OCR text takes the place of its text layer only when the page
 * was judged unreadable (garbled, or nearly empty on a scanned page), the OCR text is longer than
 * the layer once both are normalized to their readable content (readableLength: plausible words
 * and numbers only), and the OCR text itself passes the quality check. Otherwise the layer stays; reason says why, for the log. A readable page with a
 * logo must never lose its text to the few words OCR finds in the logo.
 */
export function ocrReplaces(
  layer: { text: string; reason: 'garbled' | 'sparse' } | undefined,
  ocrText: string,
): { replace: boolean; reason: string } {
  if (!layer) return { replace: false, reason: 'the page was not judged unreadable' };
  const ocrLen = readableLength(ocrText);
  const layerLen = readableLength(layer.text);
  if (ocrLen <= layerLen)
    return {
      replace: false,
      reason: `OCR text (${ocrLen} readable characters) is not longer than the layer (${layerLen})`,
    };
  if (isGarbled(pageQuality(ocrText))) return { replace: false, reason: 'OCR text fails the quality check' };
  return { replace: true, reason: `${layer.reason} layer (${layerLen} readable characters), OCR text ${ocrLen}` };
}

/** The parser switches of the indexing options (the OCR switch belongs to the ocr hook). */
function splitOptions(o: IndexingOptions = {}) {
  return { structuredTables: Boolean(o.structuredTables), cjkHeadings: Boolean(o.cjkHeadings) };
}

/**
 * Parses and chunks one file; shared by the watcher and the eval harness so both index the same
 * split. A PDF without a text layer is OCRed whole. A PDF with garbled pages (ocrPages) gets those
 * pages OCRed and is parsed again with their OCR text; a page whose OCR finds nothing keeps its
 * text layer. Without an ocr hook a garbled page stays as it is.
 */
export async function splitWithOcr(
  filePath: string,
  o: { maxChars: number; ocr?: OcrFn; log?: (msg: string) => void; indexing?: IndexingOptions },
): Promise<{ parsed: ParsedDocument; chunks: Chunk[]; ocrReplaced: number[] }> {
  const so = splitOptions(o.indexing);
  let parsed = await parseFile(filePath, so);
  let sections = parsed.sections;
  let ocrReplaced: number[] = [];
  if (parsed.needsOcr) {
    if (!o.ocr) throw new Error('no text layer and no OCR available');
    sections = sectionsFromOcr(await o.ocr(filePath), path.basename(filePath));
  } else if (parsed.ocrPages?.length) {
    const name = path.basename(filePath);
    if (!o.ocr) {
      o.log?.(`${name}: garbled text layer on pages ${parsed.ocrPages.join(', ')}, kept (no OCR available)`);
    } else {
      const pages = await o.ocr(filePath, parsed.ocrPages);
      const found = new Map(pages.filter((p) => p.page > 0 && p.text.trim()).map((p) => [p.page, p.text]));
      const text = new Map<number, string>();
      const guarded: string[] = [];
      for (const [page, ocrText] of [...found].sort(([a], [b]) => a - b)) {
        const d = ocrReplaces(parsed.ocrLayer?.[page], ocrText);
        if (d.replace) text.set(page, ocrText);
        else guarded.push(`${page} (${d.reason})`);
      }
      ocrReplaced = [...text.keys()];
      const kept = parsed.ocrPages.filter((p) => !found.has(p));
      o.log?.(
        `${name}: garbled text layer on pages ${parsed.ocrPages.join(', ')}; replaced with OCR: ${ocrReplaced.join(', ') || 'none'}` +
          (kept.length ? `; kept (OCR found no text): ${kept.join(', ')}` : '') +
          (guarded.length ? `; kept (guard): ${guarded.join(', ')}` : ''),
      );
      if (text.size) {
        parsed = { ...(await parseFile(filePath, { pageText: text, ...so })), ocrPages: parsed.ocrPages };
        sections = parsed.sections;
      }
    }
  }
  return {
    parsed,
    chunks: chunkSections(sections, { maxChars: o.maxChars, pageLabels: parsed.pageLabels }),
    ocrReplaced,
  };
}

/**
 * The watcher's splitter: Session G's parsers and chunker (src/main/sections). maxChars is the
 * preset's chunkMaxChars and embeddingModel its embedder, both part of the split key.
 * A PDF without a text layer needs OCR, which only the collector does (collectorOcr in ocr.ts);
 * without an ocr hook such a file fails, so it ends on the dead-letter list instead of being
 * indexed as empty.
 */
export function sectionSplitter(o: {
  maxChars: number;
  embeddingModel: string;
  ocr?: OcrFn;
  log?: (msg: string) => void;
  /** The preset's indexing switches; part of the split key. */
  indexing?: IndexingOptions;
}): Splitter {
  const splitKey = splitKeyOf({
    splitterVersion: SPLITTER_VERSION,
    strategy: SPLIT_STRATEGY,
    maxChars: o.maxChars,
    embeddingModel: o.embeddingModel,
    indexing: o.indexing,
  });
  return {
    splitKey,
    async split(filePath, stats?: SplitStats) {
      const ocr: OcrFn | undefined =
        o.ocr &&
        (async (file, pages) => {
          const t0 = Date.now();
          try {
            return await o.ocr!(file, pages);
          } finally {
            if (stats) stats.ocrMs += Date.now() - t0;
          }
        });
      const r = await splitWithOcr(filePath, { ...o, ocr });
      if (stats) stats.ocrPages += r.parsed.needsOcr ? r.parsed.pages : r.ocrReplaced.length;
      return r.chunks;
    },
  };
}
