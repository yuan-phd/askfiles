// A browse index seeded from real files for the browse page tests: the real folder watcher, splitter
// and browse index from dist/main (npm run test:e2e builds it) run over a temp copy of the files,
// with an in-memory library instead of the server, and the page reaches the index through a stub
// of the preload bridge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowseIndex, chunkReader, followWatcher } from '../../dist/main/browse/index.js';
import { FolderWatcher, sectionSplitter } from '../../dist/main/watcher/index.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

/** Corpus S and the long Word file of corpus L: PDF, Word, Excel and Markdown, Chinese and English. */
export const SEED_FILES = [
  'eval-s/corpus/budget-2026.xlsx',
  'eval-s/corpus/it-handbook.pdf',
  'eval-s/corpus/leave-policy-v1.md',
  'eval-s/corpus/leave-policy-v2.md',
  'eval-s/corpus/报销制度.docx',
  'eval-l/corpus/operations-manual.docx',
];

function memoryLibrary() {
  const embedded = new Map();
  return {
    async updateEmbeddings(_slug, { adds, deletes }) {
      for (const a of adds) embedded.set(a, `doc-${embedded.size + 1}`);
      for (const d of deletes) embedded.delete(d);
    },
    async removeDocuments(_slug, locations) {
      for (const l of locations) embedded.delete(l);
    },
    async workspaceDocuments() {
      return new Map(embedded);
    },
  };
}

/**
 * Indexes the files into a temp library folder. mtimes gives each file a modification time (ms)
 * by its base name, so sorting by date is predictable. Returns the index and a cleanup function.
 */
export async function seedBrowse({ files = SEED_FILES, mtimes = {} } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-browse-e2e-')));
  const root = path.join(tmp, 'Documents');
  for (const f of files) {
    const to = path.join(root, path.basename(f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, f), to);
    const t = mtimes[path.basename(f)];
    if (t) fs.utimesSync(to, t / 1000, t / 1000);
  }
  const storageDir = path.join(tmp, 'storage');
  const watcher = new FolderWatcher({
    root,
    dataDir: tmp,
    storageDir,
    workspaceSlug: 'library',
    api: memoryLibrary(),
    splitter: sectionSplitter({ maxChars: 1500, embeddingModel: 'all-minilm:latest' }),
    watch: () => ({ ready: Promise.resolve(), close: async () => {} }),
    debounceMs: 1,
    stableMs: 1,
    log: () => {},
  });
  const index = new BrowseIndex({
    dir: path.join(tmp, 'browse'),
    root,
    readChunk: chunkReader(storageDir),
    log: () => {},
  });
  followWatcher(index, watcher);
  await watcher.start();
  await watcher.whenIdle();
  index.sync(watcher.files());
  const dead = watcher.status().deadLetters;
  await watcher.stop();
  if (dead.length) throw new Error(`seed files not indexed: ${JSON.stringify(dead)}`);
  return { index, root, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/**
 * Stands in for the preload bridge (src/main/preload.ts) with the seeded index behind
 * window.askfiles.browse. window.__opened records openOriginal calls, window.__watcher(status)
 * pushes a watcher status event, window.__bridgeCalls records pageReady.
 */
export async function stubBrowseBridge(page, index, { status = null } = {}) {
  await page.exposeFunction('__browseCall', (method, arg) => {
    switch (method) {
      case 'documents':
        return index.listDocuments();
      case 'document':
        return index.getDocument(arg ?? {});
      case 'headings':
        return index.headings({ key: arg ?? null });
      case 'search':
        return index.search(String(arg ?? ''));
      default:
        throw new Error(`unknown browse call ${method}`);
    }
  });
  await page.addInitScript((initial) => {
    const listeners = [];
    window.__opened = [];
    window.__bridgeCalls = [];
    window.__watcher = (s) => listeners.forEach((l) => l(s));
    window.askfiles = {
      watcher: {
        status: async () => initial,
        onStatus: (cb) => {
          listeners.push(cb);
          return () => listeners.splice(listeners.indexOf(cb), 1);
        },
      },
      library: {
        resolveSources: async (s) => s,
        openOriginal: async (source) => {
          window.__opened.push(source);
          return true;
        },
      },
      browse: {
        documents: () => window.__browseCall('documents'),
        document: (ref) => window.__browseCall('document', ref),
        headings: (key) => window.__browseCall('headings', key ?? null),
        search: (query) => window.__browseCall('search', query),
      },
      app: {
        info: async () => ({ name: 'AskFiles', version: '0.1.0' }),
        pageReady: (info) => window.__bridgeCalls.push(['pageReady', info]),
      },
    };
  }, status);
}
