import path from 'node:path';
import { chunkSections, parseFile, parsePlainText, splitKeyOf, SPLITTER_VERSION } from '../sections/index.js';
import type { Splitter } from './types.js';

/** Same strategy name the evaluation harness uses (scripts/eval/config.ts), so split keys match. */
export const SPLIT_STRATEGY = 'heading';

/**
 * The watcher's splitter: Session G's parsers and chunker (src/main/sections). maxChars is the
 * preset's chunkMaxChars and embeddingModel its embedder, both part of the split key.
 * A PDF without a text layer needs OCR, which only the collector does; without an ocr hook such a
 * file fails, so it ends on the dead-letter list instead of being indexed as empty.
 */
export function sectionSplitter(o: {
  maxChars: number;
  embeddingModel: string;
  ocr?: (filePath: string) => Promise<string>;
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
      let parsed = await parseFile(filePath);
      if (parsed.needsOcr) {
        if (!o.ocr) throw new Error('no text layer; OCR is not wired into the watcher yet');
        parsed = {
          ...parsePlainText(await o.ocr(filePath), path.basename(filePath)),
          pages: parsed.pages,
          needsOcr: true,
        };
      }
      return chunkSections(parsed.sections, { maxChars: o.maxChars });
    },
  };
}
