import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowseIndex, type StoredChunk } from '../../browse/index.js';
import type { FileRecord } from '../../watcher/index.js';

export interface FixtureSection {
  title: string;
  level?: number;
  /** Sub-chunk bodies; one entry for a section that fits one chunk. */
  parts: string[];
  page?: number | null;
}

export interface FixtureFile {
  name: string;
  sections: FixtureSection[];
}

/**
 * A browse index over in-memory files, built through the real BrowseIndex.update path: one
 * FileRecord per file and a chunk text per sub-chunk, as the watcher writes them.
 */
export function fixtureLibrary(files: FixtureFile[]): {
  index: BrowseIndex;
  records: FileRecord[];
  chunkText: Map<string, string>;
  root: string;
  cleanup: () => void;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-answer-'));
  const root = path.join(tmp, 'Documents');
  const chunks = new Map<string, StoredChunk>();
  const chunkText = new Map<string, string>();
  const records: FileRecord[] = files.map((f) => {
    const abs = path.join(root, f.name);
    const sections: FileRecord['sections'] = [];
    f.sections.forEach((s, i) => {
      s.parts.forEach((body, k) => {
        const location = `askfiles/${f.name}-${i + 1}-${k + 1}.json`;
        const pageContent = `${s.title}\n${body}`;
        chunks.set(location, { pageContent, sectionLevel: s.level ?? 1 });
        chunkText.set(location, pageContent);
        sections.push({
          location,
          docId: null,
          sectionTitle: s.title,
          sectionIndex: i + 1,
          subIndex: k + 1,
          pageStart: s.page ?? null,
          pageEnd: s.page ?? null,
        });
      });
    });
    return {
      path: abs,
      url: pathToFileURL(abs).href,
      hash: `hash-${f.name}`,
      splitKey: 'k',
      size: 1,
      mtimeMs: 1,
      indexedAt: '2026-10-30T00:00:00.000Z',
      sections,
    };
  });
  const index = new BrowseIndex({
    dir: path.join(tmp, 'browse'),
    root,
    readChunk: (location) => chunks.get(location) ?? null,
    log: () => {},
  });
  for (const r of records) index.update(r);
  return { index, records, chunkText, root, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
