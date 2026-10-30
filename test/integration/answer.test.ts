// The answer pipeline (src/main/answer) against the real server and the test models: a folder
// watched by the real FolderWatcher and browse index, vector search through upstream, the MiniLM
// reranker, and qwen3:0.6b through Ollama. Needs RUN_INTEGRATION=1, Ollama with the test models,
// the upstream packages, the compiled main process (npm run build:main) for test/e2e/upstream.mts,
// and the reranker files, fetched from huggingface.co into .eval-data/models/reranker when missing
// (ASKFILES_RERANKER_DIR overrides the folder).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript client from Session D without type declarations
import { createClient, generateApiKey, REFUSAL_TEXT } from '../../src/renderer/api/client.js';
import {
  answer,
  choose,
  rerankerProcess,
  DEFAULT_PARAMS,
  ensureReranker,
  ollamaChat,
  retrieve,
  upstreamVectorSearch,
  type PipelineDeps,
  type RunSettings,
} from '../../src/main/answer/index.js';
import { BrowseIndex, chunkReader, followWatcher } from '../../src/main/browse/index.js';
import { chokidarWatch, createLibraryApi, FolderWatcher, sectionSplitter } from '../../src/main/watcher/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RERANKER = 'Xenova/ms-marco-MiniLM-L-6-v2';
const RERANKER_DIR = process.env.ASKFILES_RERANKER_DIR || path.join(ROOT, '.eval-data', 'models', 'reranker');
const log = (msg: string) => console.log(`[integration] ${msg}`);

// The answer to the first question is in exactly one section, under a made-up name that no
// embedding model has seen, so only the keyword index can tie it to the question.
const HANDBOOK = `# Northwind handbook

## Annual leave

Permanent employees receive 27 days of paid annual leave per calendar year. Leave is booked in the HR system.

## Quarvex reviews

Every Quarvex review is chaired by the operations director and takes place on the second Tuesday of each quarter.

## Travel

Train travel is booked in second class unless the trip takes longer than four hours.

## Parking

Staff park for free in the garage on level minus two.
`;

const POLICY = `# 报销制度

## 差旅报销

上海的住宿报销上限为每晚650元，北京为每晚600元。

## 提交期限

报销申请须在费用发生后30天内通过财务系统提交，逾期不予受理。
`;

function skipReason(): string | null {
  if (process.env.RUN_INTEGRATION !== '1') return 'RUN_INTEGRATION is not 1';
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'process-manager', 'index.js'))) {
    return 'dist/main is missing; run npm run build:main';
  }
  return null;
}

let reason = skipReason();
type Upstream = {
  baseUrl: string;
  storageDir: string;
  manager: { status(): { ports?: { ollama?: number } | null } };
  stop: () => Promise<void>;
};
let upstream: Upstream | null = null;
let deps: PipelineDeps | null = null;
let watcher: FolderWatcher | null = null;
let tmp = '';
if (!reason) {
  const mod = (await import('../e2e/upstream.mts')) as {
    skipReason: () => string | null;
    startUpstream: (o: { allowedOrigins: string[] }) => Promise<Upstream>;
  };
  reason = mod.skipReason();
  if (!reason) {
    beforeAll(async () => {
      await ensureReranker({ repo: RERANKER, modelsDir: RERANKER_DIR, log });
      upstream = await mod.startUpstream({ allowedOrigins: [] });
      const up = upstream;
      const apiKey = await generateApiKey({ baseUrl: up.baseUrl, name: 'askfiles-answer-it' });
      const client = createClient({ baseUrl: up.baseUrl, apiKey });
      const ws = await client.createWorkspace('askfiles-answer-it', {
        chatMode: 'query',
        queryRefusalResponse: REFUSAL_TEXT,
      });

      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-answer-it-')));
      const folder = path.join(tmp, 'Documents');
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'handbook.md'), HANDBOOK);
      fs.writeFileSync(path.join(folder, '报销制度.md'), POLICY);
      const w = new FolderWatcher({
        root: folder,
        dataDir: path.join(tmp, 'shell'),
        storageDir: up.storageDir,
        workspaceSlug: ws.slug,
        api: createLibraryApi({ baseUrl: up.baseUrl, apiKey }),
        splitter: sectionSplitter({ maxChars: 1000, embeddingModel: 'all-minilm:latest' }),
        watch: chokidarWatch,
        log: (m) => log(`[watcher] ${m}`),
      });
      const index = new BrowseIndex({
        dir: path.join(tmp, 'shell', 'browse'),
        root: folder,
        readChunk: chunkReader(up.storageDir),
        log: () => {},
      });
      followWatcher(index, w);
      await w.start();
      // start() resolves once watching; the files are indexed by the queue after it.
      const t0 = Date.now();
      while (w.files().length < 2 || w.status().pending > 0) {
        if (Date.now() - t0 > 300_000) throw new Error(`indexing not done: ${JSON.stringify(w.status())}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      index.sync(w.files());
      watcher = w;
      log(`indexed ${w.files().length} files, ${index.sectionTotal()} sections`);
      const ollama = `http://127.0.0.1:${up.manager.status().ports!.ollama}`;
      deps = {
        vectorSearch: upstreamVectorSearch({ baseUrl: () => up.baseUrl, apiKey, slug: ws.slug }),
        resolveSources: (s) => w.resolveSources(s),
        index,
        reranker: rerankerProcess({
          transformersDir: path.join(ROOT, 'upstream', 'server', 'node_modules', '@xenova', 'transformers'),
          modelsDir: RERANKER_DIR,
          repo: RERANKER,
          log,
        }),
        chat: ollamaChat(() => ollama),
      };
    }, 900_000);
  }
}
if (reason) process.stderr.write(`[integration] answer pipeline skipped: ${reason}\n`);

afterAll(async () => {
  (deps?.reranker as { stop?: () => void } | null)?.stop?.();
  await watcher?.stop();
  await upstream?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// One source for the small test model, so a citation can only be [1].
const settings = (over: Partial<RunSettings['params']> = {}): RunSettings => ({
  params: { ...DEFAULT_PARAMS, ...over },
  scope: 'strict',
  chatModel: 'qwen3:0.6b',
  contextLength: 4096,
  chunkMaxChars: 1000,
  temperature: 0,
});

describe.skipIf(reason !== null)('answer pipeline against the real server', () => {
  it('answers a question whose term is in one section only, citing that section', async () => {
    const s = settings({
      sectionCount: { strict: 1, balanced: 3, broad: 5 },
      rerankFloor: { strict: 0.01, balanced: 0, broad: 0 },
    });
    const q = 'Who chairs the Quarvex review?';
    const r = await retrieve(q, s, deps!);
    log(`terms ${r.terms.map((t) => t.text).join(', ')}; keyword ${r.keyword.map((k) => k.section).join(', ')}`);
    log(`candidates ${r.candidates.map((c, i) => `${c.title}=${r.rerank[i]?.toFixed(3)}`).join(', ')}`);
    expect(r.terms.map((t) => t.text)).toContain('quarvex');
    const sel = choose(r, s);
    expect(sel.selected.map((x) => x.section.title)).toEqual(['Quarvex reviews']);
    const result = await answer(q, r, sel, s, deps!);
    log(`answer ${JSON.stringify(result.text)}, first token ${result.timings.firstTokenMs} ms`);
    expect(result.notFound).toBe(false);
    expect(result.cited.map((c) => [c.n, c.file, c.title])).toEqual([[1, 'handbook.md', 'Quarvex reviews']]);
  });

  it('a question with no answer in the library ends in the not-found state', async () => {
    // The strict floor of the defaults: MiniLM scores unrelated sections near zero. The bypass is
    // off, since the Chinese file in this library would otherwise skip reranking and the floor.
    const s = settings({ rerankerBypassCjk: false });
    const q = 'What is the capital of Australia?';
    const r = await retrieve(q, s, deps!);
    log(`candidates ${r.candidates.map((c, i) => `${c.title}=${r.rerank[i]?.toFixed(4)}`).join(', ')}`);
    const result = await answer(q, r, choose(r, s), s, deps!);
    expect(result.notFound).toBe(true);
    expect(result.cited).toEqual([]);
    expect(result.nearest.length).toBeGreaterThan(0);
  });

  it('a Chinese question against the Chinese document cites a Chinese section', async () => {
    const s = settings({ sectionCount: { strict: 1, balanced: 3, broad: 5 } });
    const q = '上海的住宿报销上限是多少？';
    const r = await retrieve(q, s, deps!);
    log(`bypass ${r.bypassReason}; terms ${r.terms.map((t) => t.text).join(', ')}`);
    expect(r.bypassReason).toBe('question is mainly CJK');
    const sel = choose(r, s);
    expect(sel.selected.map((x) => x.section.title)).toEqual(['差旅报销']);
    const result = await answer(q, r, sel, s, deps!);
    log(`answer ${JSON.stringify(result.text)}`);
    expect(result.notFound).toBe(false);
    expect(result.cited.map((c) => [c.file, c.title])).toEqual([['报销制度.md', '差旅报销']]);
  });
});
