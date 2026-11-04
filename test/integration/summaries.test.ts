// The summary layer (src/main/summaries, docs/summaries.md) against the real backend: the English
// files of corpus S indexed by the real FolderWatcher through upstream, the browse index and the
// library graph built from it, and summaries made by the test chat model through Ollama. Checks
// that every document summary kept is within its cap and supported by its source, that one
// document's section summaries are made on demand, and that the export folder is Obsidian Markdown
// (front matter and [[links]] parsed). Needs RUN_INTEGRATION=1, Ollama with the test models
// (ASKFILES_TEST_CHAT_MODEL, ASKFILES_TEST_EMBED_MODEL override qwen3:0.6b and all-minilm), the
// upstream packages and the compiled main process (npm run build:main).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript client from Session D without type declarations
import { createClient, generateApiKey, REFUSAL_TEXT } from '../../src/renderer/api/client.js';
import { ollamaChat } from '../../src/main/answer/index.js';
import { BrowseIndex, chunkReader, followWatcher } from '../../src/main/browse/index.js';
import { GraphService, loadProfiles, profileFor } from '../../src/main/graph/index.js';
import { checkSummary, documentSource, SummaryService, withinCap } from '../../src/main/summaries/index.js';
import { chokidarWatch, createLibraryApi, FolderWatcher, sectionSplitter } from '../../src/main/watcher/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = path.join(ROOT, 'test', 'fixtures', 'eval-s', 'corpus');
/** The English files of corpus S. */
const FILES = ['it-handbook.pdf', 'leave-policy-v1.md', 'leave-policy-v2.md', 'budget-2026.xlsx'];
const log = (msg: string) => console.log(`[integration] ${msg}`);

function skipReason(): string | null {
  if (process.env.RUN_INTEGRATION !== '1') return 'RUN_INTEGRATION is not 1';
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'process-manager', 'index.js'))) {
    return 'dist/main is missing; run npm run build:main';
  }
  return null;
}

type Upstream = {
  baseUrl: string;
  storageDir: string;
  manager: { status(): { ports?: { ollama?: number } | null } };
  stop: () => Promise<void>;
};

let reason = skipReason();
let upstream: Upstream | null = null;
let watcher: FolderWatcher | null = null;
let index: BrowseIndex | null = null;
let summaries: SummaryService | null = null;
let graph: GraphService | null = null;
let tmp = '';
let chatModel = 'qwen3:0.6b';

async function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`${what} not done within ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (!reason) {
  const mod = (await import('../e2e/upstream.mts')) as {
    skipReason: () => string | null;
    startUpstream: (o: { allowedOrigins: string[] }) => Promise<Upstream>;
    CHAT_MODEL: string;
    EMBED_MODEL: string;
  };
  reason = mod.skipReason();
  chatModel = mod.CHAT_MODEL;
  if (!reason) {
    beforeAll(async () => {
      upstream = await mod.startUpstream({ allowedOrigins: [] });
      const up = upstream;
      const apiKey = await generateApiKey({ baseUrl: up.baseUrl, name: 'askfiles-summaries-it' });
      const client = createClient({ baseUrl: up.baseUrl, apiKey });
      const ws = await client.createWorkspace('askfiles-summaries-it', {
        chatMode: 'query',
        queryRefusalResponse: REFUSAL_TEXT,
      });
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-summaries-it-')));
      const folder = path.join(tmp, 'Documents');
      fs.mkdirSync(folder);
      for (const f of FILES) fs.copyFileSync(path.join(CORPUS, f), path.join(folder, f));
      const lib = path.join(tmp, 'library');
      const w = new FolderWatcher({
        root: folder,
        dataDir: lib,
        storageDir: up.storageDir,
        workspaceSlug: ws.slug,
        api: createLibraryApi({ baseUrl: up.baseUrl, apiKey }),
        splitter: sectionSplitter({ maxChars: 1500, embeddingModel: mod.EMBED_MODEL }),
        watch: chokidarWatch,
        log: (m) => log(`[watcher] ${m}`),
      });
      const b = new BrowseIndex({
        dir: path.join(lib, 'browse'),
        root: folder,
        readChunk: chunkReader(up.storageDir),
        log: () => {},
      });
      const profile = profileFor(loadProfiles(path.join(ROOT, 'config', 'profiles')), 'legal-finance');
      const g = new GraphService({
        browse: b,
        file: path.join(lib, 'graph.json'),
        options: () => ({ profile, overrides: {}, familyDecisions: {} }),
      });
      const ollama = `http://127.0.0.1:${up.manager.status().ports!.ollama}`;
      const s = new SummaryService({
        browse: b,
        dir: path.join(lib, 'summaries'),
        exportDir: path.join(lib, 'export'),
        chat: ollamaChat(() => ollama),
        model: () => ({ model: chatModel, contextLength: 4096, temperature: 0 }),
        librarySections: () => false,
        graph: () => g.data(),
        idleMs: 500,
        exportDebounceMs: 200,
        log,
      });
      // The queue waits while the watcher indexes, as the app does (docs/summaries.md, Queue).
      w.on('status', (st) => s.setIndexing(st.state === 'working' || st.state === 'starting' || st.pending > 0));
      followWatcher(b, w);
      await w.start();
      await until('indexing', () => w.files().length >= FILES.length && w.status().pending === 0, 300_000);
      b.sync(w.files());
      watcher = w;
      index = b;
      graph = g;
      summaries = s;
      log(`indexed ${w.files().length} files, ${b.sectionTotal()} sections; summarizing with ${chatModel}`);
    }, 900_000);
  }
}
if (reason) process.stderr.write(`[integration] summaries skipped: ${reason}\n`);

afterAll(async () => {
  summaries?.stop();
  graph?.stop();
  await watcher?.stop();
  await upstream?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(reason !== null)('summaries against the real backend', () => {
  it('summarizes every English document; each kept summary fits its cap and its source supports it', async () => {
    const s = summaries!;
    const docs = index!.allDocuments();
    await until('document summaries', () => docs.every((d) => s.view(d.id)!.state !== 'pending'), 600_000);
    const kept = [];
    for (const d of docs) {
      const v = s.view(d.id)!;
      const rec = s.store.get(d.id);
      log(`${d.title}: ${v.state} ${rec.document?.status} ${JSON.stringify(v.text)}`);
      expect(['ok', 'none']).toContain(v.state);
      if (v.state !== 'ok') continue;
      kept.push(d.title);
      expect(withinCap(v.text!, 'document')).toBe(true);
      expect(checkSummary(v.text!, documentSource(d).text, 'document')).toEqual({ ok: true, text: v.text });
      expect(v.sectionIndex).toBe(documentSource(d).section!.index);
    }
    // A small test model may write a sentence its source does not support; that one is dropped.
    expect(kept.length).toBeGreaterThanOrEqual(Math.ceil(docs.length / 2));
  });

  it('makes the section summaries of one document on demand', async () => {
    const s = summaries!;
    const handbook = index!.allDocuments().find((d) => d.title === 'it-handbook.pdf')!;
    const before = s.view(handbook.id)!;
    expect(before.sectionsMissing).toBe(handbook.sections.filter((x) => x.text.trim()).length);
    s.requestSections(handbook.id);
    await until('section summaries', () => s.view(handbook.id)!.sectionsMissing === 0, 600_000);
    const v = s.view(handbook.id)!;
    log(`sections: ${JSON.stringify(v.sections)}`);
    expect(Object.keys(v.sections).length).toBeGreaterThan(0);
    for (const t of Object.values(v.sections)) expect(withinCap(t, 'section')).toBe(true);
    // The other documents got none: only the one asked for.
    for (const d of index!.allDocuments().filter((x) => x.id !== handbook.id))
      expect(Object.keys(s.view(d.id)!.sections)).toEqual([]);
  });

  it('writes an Obsidian export: front matter and links that resolve to notes', async () => {
    const r = summaries!.exportNow();
    expect(r).not.toBeNull();
    const dir = path.join(tmp, 'library', 'export');
    const notes = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    expect(notes.sort()).toEqual(FILES.map((f) => `${f.replace(/\.[a-z]+$/, '')}.md`).sort());
    const names = new Set([
      ...notes.map((n) => n.slice(0, -3)),
      ...fs.readdirSync(path.join(dir, 'Headings')).map((n) => `Headings/${n.slice(0, -3)}`),
    ]);
    for (const n of notes) {
      const text = fs.readFileSync(path.join(dir, n), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(fm, n).not.toBeNull();
      const fields = Object.fromEntries(
        fm![1]!.split('\n').map((l) => [l.slice(0, l.indexOf(':')), JSON.parse(l.slice(l.indexOf(':') + 2))]),
      );
      expect(Object.keys(fields)).toEqual(expect.arrayContaining(['title', 'type', 'source']));
      expect(FILES).toContain(fields.title);
      expect(fs.existsSync(fields.source)).toBe(true);
      for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g))
        expect(names.has(m[1]!), `${n} links ${m[1]}`).toBe(true);
    }
    // The two leave policies share their headings: one note per shared heading lists both.
    const shared = fs.readdirSync(path.join(dir, 'Headings'));
    expect(shared.length).toBeGreaterThan(0);
    const one = fs.readFileSync(path.join(dir, 'Headings', shared[0]!), 'utf8');
    expect(one).toContain('[[leave-policy-v1]]');
    expect(one).toContain('[[leave-policy-v2]]');
  });
});
