import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REMOVAL_STEPS,
  removeLibraryData,
  selfCheck,
  uuidv5,
  vectorCacheName,
  type RemovalStep,
} from './library-data.js';
import { emptyShellState, type LibraryRecord, type ShellState } from './shell-state.js';

// Every name, hash and text below is invented.
const A = 'lib-0a0a0a';
const B = 'lib-0b0b0b';
const SHARED = 'a'.repeat(64);
const ONLY_A = 'c'.repeat(64);
const ONLY_B = 'd'.repeat(64);

let tmp: string;
let dataDir: string;
let storageDir: string;
let ocrCacheDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-data-')));
  dataDir = path.join(tmp, 'AskFiles');
  storageDir = path.join(dataDir, 'storage');
  ocrCacheDir = path.join(dataDir, 'ocr-cache');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function put(file: string, text = '{}'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const exists = (p: string) => fs.existsSync(p);
const docsDir = (id: string) => path.join(storageDir, 'documents', 'askfiles', id);
const libDir = (id: string) => path.join(dataDir, 'libraries', id);
const lanceOf = (slug: string) => path.join(storageDir, 'lancedb', `${slug}.lance`);
const cacheOf = (docpath: string) => path.join(storageDir, 'vector-cache', vectorCacheName(docpath));
const ocrOf = (name: string) => path.join(ocrCacheDir, name);

/**
 * One library as the app lays it out: index.json listing files by content hash with their
 * sections, the other records, section documents, a vector table and the vector cache entries.
 */
function makeLibrary(id: string, files: { name: string; hash: string }[]): { docpaths: string[] } {
  const docpaths: string[] = [];
  const index: Record<string, unknown> = {};
  for (const f of files) {
    const location = `askfiles/${id}/folder-1-${f.name}-${f.hash.slice(0, 6)}-1-0.json`;
    docpaths.push(location);
    put(path.join(storageDir, 'documents', location), JSON.stringify({ pageContent: 'Invented text.' }));
    put(cacheOf(location), '[]');
    index[`/Users/someone/Invented/${f.name}`] = {
      path: `/Users/someone/Invented/${f.name}`,
      hash: f.hash,
      sections: [{ location }],
    };
  }
  put(path.join(libDir(id), 'index.json'), JSON.stringify({ version: 1, files: index }));
  put(path.join(libDir(id), 'browse', 'doc.json'));
  put(path.join(libDir(id), 'summaries', 'doc.json'));
  put(path.join(libDir(id), 'export', 'Invented.md'), '# Invented');
  put(path.join(libDir(id), 'graph.json'));
  put(path.join(lanceOf(`askfiles-${id}`), 'data', 'part.lance'), 'vectors');
  return { docpaths };
}

/** What must never be touched: models, the default library, the server's own files, the user's files. */
function makeKeepers(): string[] {
  return [
    put(path.join(dataDir, 'ollama', 'models', 'blobs', 'sha256-invented'), 'weights'),
    put(path.join(dataDir, 'models', 'reranker', 'model.onnx'), 'weights'),
    put(path.join(dataDir, 'ollama-home', '.ollama', 'id_ed25519'), 'key'),
    put(path.join(storageDir, 'models', 'tesseract', 'eng.traineddata'), 'ocr'),
    put(path.join(storageDir, 'askfiles.db'), 'db'),
    put(path.join(libDir('all-files'), 'index.json'), JSON.stringify({ version: 1, files: {} })),
    put(path.join(storageDir, 'documents', 'askfiles', 'all-files', 'x.json')),
    put(path.join(lanceOf('askfiles-library'), 'data')),
    put(path.join(tmp, 'Invented', 'report.md'), '# Report'),
  ];
}

function removal(id: string, o: { others?: string[]; beforeStep?: (s: RemovalStep) => void; log?: string[] } = {}) {
  const removedWorkspaces: string[] = [];
  let recordRemoved = false;
  const run = () =>
    removeLibraryData({
      dataDir,
      storageDir,
      ocrCacheDir,
      id,
      workspaceSlug: `askfiles-${id}`,
      otherLibraryIds: o.others ?? ['all-files'],
      removeWorkspace: async (slug) => void removedWorkspaces.push(slug),
      removeRecord: () => (recordRemoved = true),
      log: (m) => o.log?.push(m),
      ...(o.beforeStep ? { beforeStep: o.beforeStep } : {}),
    });
  return { run, removedWorkspaces, recordRemoved: () => recordRemoved };
}

function expectGone(id: string, docpaths: string[]): void {
  expect(exists(libDir(id))).toBe(false);
  expect(exists(docsDir(id))).toBe(false);
  expect(exists(lanceOf(`askfiles-${id}`))).toBe(false);
  for (const d of docpaths) expect(exists(cacheOf(d))).toBe(false);
}

describe('vector cache names', () => {
  it('are the uuid v5 (URL namespace) of the document path, as upstream names them', () => {
    // Computed with the uuid package upstream uses (upstream/server/node_modules/uuid 9.0.1, v5 with v5.URL).
    expect(uuidv5('askfiles/lib-0a1b2c/invented-notes-ab12cd-3-0.json')).toBe('4b1dca8a-93ff-5d4e-97f1-9bbc9d31ab6b');
    // Two libraries holding the same file post different paths, so their entries never collide.
    expect(vectorCacheName(`askfiles/${A}/folder-1-x.json`)).not.toBe(vectorCacheName(`askfiles/${B}/folder-1-x.json`));
  });
});

describe('removeLibraryData', () => {
  it('removes every place of one library and nothing else', async () => {
    const keepers = makeKeepers();
    const a = makeLibrary(A, [{ name: 'notes.md', hash: ONLY_A }]);
    const b = makeLibrary(B, [{ name: 'plan.md', hash: ONLY_B }]);
    put(ocrOf(`${ONLY_A}.pages.json`));
    put(ocrOf(`${ONLY_A}-0123456789ab-up.pages.json`));
    put(ocrOf(`${ONLY_B}.pages.json`));
    const r = removal(A, { others: ['all-files', B] });
    await r.run();
    expectGone(A, a.docpaths);
    expect(r.removedWorkspaces).toEqual([`askfiles-${A}`]);
    expect(r.recordRemoved()).toBe(true);
    expect(fs.readdirSync(ocrCacheDir)).toEqual([`${ONLY_B}.pages.json`]);
    // The other library is whole.
    expect(exists(libDir(B))).toBe(true);
    expect(exists(lanceOf(`askfiles-${B}`))).toBe(true);
    for (const d of b.docpaths) expect(exists(cacheOf(d))).toBe(true);
    for (const k of keepers) expect(exists(k)).toBe(true);
  });

  it('keeps an OCR cache entry another library still uses: two libraries sharing one file', async () => {
    const a = makeLibrary(A, [{ name: 'scan.pdf', hash: SHARED }]);
    const b = makeLibrary(B, [{ name: 'scan.pdf', hash: SHARED }]);
    put(ocrOf(`${SHARED}.pages.json`));
    // Same file, two libraries: one OCR entry, but two vector cache entries.
    expect(a.docpaths[0]).not.toBe(b.docpaths[0]);
    const log: string[] = [];
    await removal(A, { others: ['all-files', B], log }).run();
    expect(exists(ocrOf(`${SHARED}.pages.json`))).toBe(true);
    expect(log.some((l) => l.includes('kept 1 another library uses'))).toBe(true);
    for (const d of b.docpaths) expect(exists(cacheOf(d))).toBe(true);
    await removal(B, { others: ['all-files'] }).run();
    expect(exists(ocrOf(`${SHARED}.pages.json`))).toBe(false);
    expectGone(B, b.docpaths);
  });

  it('keeps the OCR cache whole when another library index cannot be read', async () => {
    makeLibrary(A, [{ name: 'scan.pdf', hash: ONLY_A }]);
    put(path.join(libDir(B), 'index.json'), 'not json');
    put(ocrOf(`${ONLY_A}.pages.json`));
    await removal(A, { others: ['all-files', B] }).run();
    expect(exists(ocrOf(`${ONLY_A}.pages.json`))).toBe(true);
    // The damaged index stays where it is: reading it here has no side effect.
    expect(fs.readFileSync(path.join(libDir(B), 'index.json'), 'utf8')).toBe('not json');
  });

  for (const [i, stop] of REMOVAL_STEPS.entries()) {
    it(`finishes a delete interrupted before step ${i + 1} (${stop}) when run again`, async () => {
      const keepers = makeKeepers();
      const a = makeLibrary(A, [
        { name: 'notes.md', hash: ONLY_A },
        { name: 'scan.pdf', hash: SHARED },
      ]);
      makeLibrary(B, [{ name: 'scan.pdf', hash: SHARED }]);
      put(ocrOf(`${ONLY_A}.pages.json`));
      put(ocrOf(`${SHARED}.pages.json`));
      const first = removal(A, {
        others: ['all-files', B],
        beforeStep: (s) => {
          if (s === stop) throw new Error(`stopped before ${s}`);
        },
      });
      await expect(first.run()).rejects.toThrow(`stopped before ${stop}`);
      // Nothing after the stop happened; the record is the last to go.
      expect(first.recordRemoved()).toBe(false);
      if (i <= REMOVAL_STEPS.indexOf('records')) expect(exists(libDir(A))).toBe(true);

      const second = removal(A, { others: ['all-files', B] });
      await second.run();
      expectGone(A, a.docpaths);
      expect(second.recordRemoved()).toBe(true);
      expect(exists(ocrOf(`${ONLY_A}.pages.json`))).toBe(false);
      expect(exists(ocrOf(`${SHARED}.pages.json`))).toBe(true);
      for (const k of keepers) expect(exists(k)).toBe(true);
    });
  }

  it('refuses All files and ids the app never gives', async () => {
    makeKeepers();
    for (const id of ['all-files', '..', 'lib-../x', 'other']) {
      await expect(removal(id).run()).rejects.toThrow('refusing to remove library');
    }
    expect(exists(libDir('all-files'))).toBe(true);
  });
});

describe('selfCheck', () => {
  function stateWith(libs: Partial<LibraryRecord>[]): ShellState {
    const s = emptyShellState();
    s.apiKey = 'K';
    s.libraries[0]!.workspaceSlug = 'askfiles-library';
    for (const l of libs)
      s.libraries.push({
        name: l.id!,
        workspaceSlug: null,
        folders: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        ...l,
      } as LibraryRecord);
    return s;
  }

  async function check(
    state: ShellState,
    o: { knownIds?: string[]; workspaces?: { name: string; slug: string }[] | null; now?: number } = {},
  ) {
    const log: string[] = [];
    const removedWorkspaces: string[] = [];
    const removed = await selfCheck({
      dataDir,
      storageDir,
      ocrCacheDir,
      state,
      knownIds: new Set(o.knownIds ?? state.libraries.map((l) => l.id)),
      listWorkspaces: async () => (o.workspaces === undefined ? [] : o.workspaces),
      removeWorkspace: async (slug) => void removedWorkspaces.push(slug),
      log: (m) => log.push(m),
      ...(o.now ? { now: () => o.now! } : {}),
    });
    return { removed, log, removedWorkspaces };
  }

  it('removes data of libraries shell.json does not name, and logs each removal', async () => {
    const keepers = makeKeepers();
    makeLibrary(A, [{ name: 'notes.md', hash: ONLY_A }]);
    const orphan = makeLibrary(B, [{ name: 'plan.md', hash: ONLY_B }]);
    put(ocrOf(`${ONLY_A}.pages.json`));
    put(ocrOf(`${ONLY_B}.pages.json`));
    // A cache entry whose document is gone, and one of upstream's own documents that is still there.
    put(cacheOf('askfiles/lib-0c0c0c/gone.json'), '[]');
    put(path.join(storageDir, 'documents', 'custom-documents', 'upstream-doc.json'));
    put(cacheOf('custom-documents/upstream-doc.json'), '[]');
    const state = stateWith([{ id: A, workspaceSlug: `askfiles-${A}` }]);
    const r = await check(state, {
      workspaces: [
        { name: 'askfiles-library', slug: 'askfiles-library' },
        { name: `askfiles-${A}`, slug: `askfiles-${A}` },
        { name: `askfiles-${B}`, slug: `askfiles-${B}` },
        { name: 'Invented notes', slug: 'invented-notes' },
      ],
    });
    expect(r.removedWorkspaces).toEqual([`askfiles-${B}`]);
    expectGone(B, orphan.docpaths);
    expect(exists(cacheOf('askfiles/lib-0c0c0c/gone.json'))).toBe(false);
    expect(exists(cacheOf('custom-documents/upstream-doc.json'))).toBe(true);
    expect(exists(ocrOf(`${ONLY_B}.pages.json`))).toBe(false);
    expect(exists(ocrOf(`${ONLY_A}.pages.json`))).toBe(true);
    expect(exists(libDir(A))).toBe(true);
    expect(exists(lanceOf(`askfiles-${A}`))).toBe(true);
    for (const k of keepers) expect(exists(k)).toBe(true);
    expect(r.removed).toEqual([
      `library folder ${B}`,
      `document folder ${B}`,
      `workspace askfiles-${B}`,
      `vector table askfiles-${B}`,
      '2 vector cache entries without a document',
      '1 OCR cache entries no library uses',
    ]);
    for (const what of r.removed) expect(r.log).toContain(`[self-check] removed ${what}`);
  });

  it('keeps data of a library whose record is damaged, and tables of workspaces it did not make', async () => {
    makeLibrary(B, [{ name: 'plan.md', hash: ONLY_B }]);
    put(path.join(lanceOf('invented-notes'), 'data'));
    // shell.json names B, but its record could not be loaded.
    const r = await check(stateWith([]), {
      knownIds: ['all-files', B],
      workspaces: [{ name: `askfiles-${B}`, slug: `askfiles-${B}` }],
    });
    expect(r.removed).toEqual([]);
    expect(r.log).toContain('[self-check] nothing to remove');
    expect(exists(libDir(B))).toBe(true);
    expect(exists(lanceOf(`askfiles-${B}`))).toBe(true);
    expect(exists(lanceOf('invented-notes'))).toBe(true);
  });

  it('touches no workspace or table when the server list cannot be had', async () => {
    makeLibrary(B, [{ name: 'plan.md', hash: ONLY_B }]);
    const r = await check(stateWith([]), { workspaces: null });
    expect(r.removedWorkspaces).toEqual([]);
    expect(exists(lanceOf(`askfiles-${B}`))).toBe(true);
    // The shell's own folders still go.
    expect(exists(libDir(B))).toBe(false);
  });

  it('keeps the OCR cache when an index cannot be read, and entries newer than the check', async () => {
    makeLibrary(A, [{ name: 'notes.md', hash: ONLY_A }]);
    put(ocrOf(`${ONLY_B}.pages.json`));
    put(path.join(libDir('all-files'), 'index.json'), 'not json');
    let r = await check(stateWith([{ id: A, workspaceSlug: `askfiles-${A}` }]));
    expect(exists(ocrOf(`${ONLY_B}.pages.json`))).toBe(true);
    expect(r.log.some((l) => l.includes('OCR cache not checked'))).toBe(true);

    fs.rmSync(path.join(libDir('all-files'), 'index.json'));
    put(cacheOf('askfiles/lib-0c0c0c/gone.json'), '[]');
    r = await check(stateWith([{ id: A, workspaceSlug: `askfiles-${A}` }]), { now: Date.now() - 60_000 });
    expect(r.removed).toEqual([]);
    expect(exists(ocrOf(`${ONLY_B}.pages.json`))).toBe(true);
  });
});
