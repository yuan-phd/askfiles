import path from 'node:path';
import { chunkSections, paragraphs, parseFile, splitKeyOf, SPLITTER_VERSION, docTitleOf } from '../sections/index.js';
import type { Section } from '../sections/index.js';
import type { OcrPage } from './ocr.js';
import type { Splitter } from './types.js';

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
  ocr?: (filePath: string) => Promise<OcrPage[]>;
}): Splitter {
  const splitKey = splitKeyOf({
    splitterVersion: SPLITTER_VERSION,
    strategy: SPLIT_STRATEGY,
    maxChars: o.maxChars,
    embeddingModel: o.embeddingModel,
  });
  return {
    splitKey,
    async split(filePath) {
      const parsed = await parseFile(filePath);
      let sections = parsed.sections;
      if (parsed.needsOcr) {
        if (!o.ocr) throw new Error('no text layer and no OCR available');
        sections = sectionsFromOcr(await o.ocr(filePath), path.basename(filePath));
      }
      return chunkSections(sections, { maxChars: o.maxChars, pageLabels: parsed.pageLabels });
    },
  };
}
