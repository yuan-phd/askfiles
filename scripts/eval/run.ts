// Retrieval evaluation run (plan task 2.3): splits a corpus by section, embeds it into a hidden
// workspace with the configuration under test, asks every question in every pass, and writes
// results.csv and run.json for the owner to score. Usage: docs/eval.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  createClient,
  generateApiKey,
  isNothingFound,
  normalizeSource,
  REFUSAL_TEXT,
  splitThinking,
} from '../../src/renderer/api/client.js';
import { loadConfig, redact, type EvalConfig } from './config.js';
import { csvHeader, csvLine } from './csv.js';
import { prepareLibrary, type ChunkInfo, type Library, type LibraryClient } from './library.js';
import { describeSources, fileHit, pageHit, sectionHit, sectionRecall, type SourceRecord } from './metrics.js';
import { listOf, loadQuestions, type Question } from './questions.js';
import { RESULT_COLUMNS } from './results.js';
import { startManaged, type Stack } from './stack.js';

const ROOT = path.resolve(__dirname, '..', '..');
const FALLBACK_TOP_N = 8; // as src/renderer/search/search.js
const log = (msg: string) => console.log(`[eval] ${msg}`);

const USAGE = `usage: npm run eval -- <corpus folder> <questions.csv> [--config file.json] [--corpus-label S|L] [--out folder]

  --config        run configuration (default scripts/eval/configs/default.json)
  --corpus-label  name of the corpus recorded in run.json (default: corpus folder name)
  --out           run folder (default eval-runs/<time>-<corpus>-<config label>)`;

interface ChatOutcome {
  text: string;
  sources: SourceRecord[];
  firstTokenMs: number | null;
  totalMs: number;
  metrics: Record<string, unknown>;
  chatId: string;
  error: string;
}

type Client = ReturnType<typeof createClient>;

function toRecord(raw: Record<string, unknown>): SourceRecord {
  const s = normalizeSource(raw);
  return {
    file: s.title,
    sectionTitle: s.sectionTitle,
    sectionIndex: s.sectionIndex,
    page: s.page,
    pageEnd: s.pageEnd,
    score: s.score,
    passage: s.text,
  };
}

/**
 * vector-search drops the section keys (docs/upstream-analysis.md Q15); they are restored from the
 * chunks this run wrote, matched on the chunk text.
 */
export function resolveFallback(raw: Record<string, unknown>[], index: Map<string, ChunkInfo>): SourceRecord[] {
  return raw.map((r) => {
    const rec = toRecord(r);
    const hit = index.get(rec.passage.trim());
    if (!hit) return rec;
    return {
      ...rec,
      file: hit.file,
      sectionTitle: hit.sectionTitle,
      sectionIndex: hit.sectionIndex,
      page: hit.pageStart > 0 ? hit.pageStart : null,
      pageEnd: hit.pageEnd > 0 ? hit.pageEnd : null,
    };
  });
}

async function ask(client: Client, slug: string, config: EvalConfig, question: string): Promise<ChatOutcome> {
  const t0 = performance.now();
  const out: ChatOutcome = {
    text: '',
    sources: [],
    firstTokenMs: null,
    totalMs: 0,
    metrics: {},
    chatId: '',
    error: '',
  };
  try {
    // The JSDoc-inferred option type of streamChat leaves out reasoningEffort, which it does take.
    const streamChat = client.streamChat as (
      slug: string,
      message: string,
      opts: { mode: string; reasoningEffort?: string },
    ) => AsyncIterable<Record<string, unknown>>;
    const events = streamChat(slug, question, {
      mode: config.chatMode,
      reasoningEffort: config.reasoningEffort || undefined,
    });
    for await (const ev of events) {
      const piece = typeof ev.textResponse === 'string' ? ev.textResponse : '';
      // First token: the first event carrying text, which for a refusal is the refusal itself.
      if (out.firstTokenMs === null && piece) out.firstTokenMs = Math.round(performance.now() - t0);
      if (ev.type === 'textResponseChunk') out.text += piece;
      if (ev.type === 'textResponse') out.text = piece;
      if (Array.isArray(ev.sources) && ev.sources.length) {
        out.sources = (ev.sources as Record<string, unknown>[]).map(toRecord);
      }
      if (ev.metrics && typeof ev.metrics === 'object') out.metrics = ev.metrics as Record<string, unknown>;
      if (ev.chatId) out.chatId = String(ev.chatId);
      if (ev.error) out.error = typeof ev.error === 'string' ? ev.error : 'error';
      if (ev.type === 'abort' && !out.error) out.error = 'aborted';
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  out.totalMs = Math.round(performance.now() - t0);
  return out;
}

const yesNo = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'no');

export function resultRow(opts: {
  runId: string;
  corpus: string;
  pass: number;
  q: Question;
  outcome: ChatOutcome;
  fallback: SourceRecord[];
}): Record<string, unknown> {
  const { q, outcome, fallback } = opts;
  const { answer } = splitThinking(outcome.text);
  const refused = !outcome.error && isNothingFound({ text: outcome.text, sources: outcome.sources }, REFUSAL_TEXT);
  const listed = refused ? fallback : outcome.sources;
  const recall = q.category === 'section_listing' ? sectionRecall(q, listed) : null;
  const m = outcome.metrics;
  return {
    run_id: opts.runId,
    corpus: opts.corpus,
    pass: opts.pass,
    ...q,
    answer,
    refused: yesNo(refused),
    thinking: yesNo(/<think>/i.test(outcome.text)),
    sources: describeSources(outcome.sources),
    file_hit: yesNo(fileHit(q, outcome.sources)),
    section_hit: yesNo(sectionHit(q, outcome.sources)),
    page_hit: yesNo(pageHit(q, outcome.sources)),
    section_recall: recall === null ? '' : recall.toFixed(2),
    fallback_sections: describeSources(fallback),
    first_token_ms: outcome.firstTokenMs ?? '',
    total_ms: outcome.totalMs,
    prompt_tokens: m.prompt_tokens ?? '',
    completion_tokens: m.completion_tokens ?? '',
    chat_id: outcome.chatId,
    error: outcome.error,
    sources_json: outcome.sources.length ? JSON.stringify(outcome.sources) : '',
    fallback_json: fallback.length ? JSON.stringify(fallback) : '',
    score: '',
    score_note: '',
  };
}

async function ollamaInfo(ollamaUrl: string, models: string[]): Promise<Record<string, unknown>> {
  const version = (await (await fetch(`${ollamaUrl}/api/version`)).json()) as { version?: string };
  const tags = (await (await fetch(`${ollamaUrl}/api/tags`)).json()) as { models?: Record<string, unknown>[] };
  const all = tags.models ?? [];
  // Ollama lists bge-m3 as bge-m3:latest; a config may name it either way.
  const full = (n: string) => (n.includes(':') ? n : `${n}:latest`);
  const pick = (name: string) => all.find((m) => full(String(m.name)) === full(name)) ?? null;
  const missing = models.filter((m) => !pick(m));
  if (missing.length) {
    throw new Error(`Ollama at ${ollamaUrl} does not have ${missing.join(', ')}; run ollama pull for each`);
  }
  return {
    url: ollamaUrl,
    version: version.version ?? null,
    models: Object.fromEntries(
      models.map((m) => {
        const t = pick(m)!;
        return [m, { name: t.name, digest: t.digest, size: t.size, modified_at: t.modified_at, details: t.details }];
      }),
    ),
  };
}

function gitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

async function connectExternal(config: EvalConfig): Promise<{ stack: Stack; apiKey: string }> {
  const apiKey = config.apiKey || (await generateApiKey({ baseUrl: config.baseUrl, name: 'askfiles-eval' }));
  const res = await fetch(`${config.baseUrl}/api/v1/system`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`GET /api/v1/system returned ${res.status}; check baseUrl and apiKey`);
  const { settings } = (await res.json()) as { settings: Record<string, unknown> };
  if (settings.EmbeddingModelPref !== config.embeddingModel) {
    throw new Error(
      `the server embeds with ${String(settings.EmbeddingModelPref)}, the config asks for ${config.embeddingModel}; ` +
        'change one of them (changing the server setting wipes its vectors)',
    );
  }
  const limit = Number(settings.EmbeddingModelMaxChunkLength || 1000);
  if (limit < config.chunkMax) {
    throw new Error(
      `the server's EMBEDDING_MODEL_MAX_CHUNK_LENGTH is ${limit}, below chunkMax ${config.chunkMax}; upstream would cut the chunks again`,
    );
  }
  return {
    apiKey,
    stack: {
      baseUrl: config.baseUrl,
      storageDir: config.storageDir,
      ollamaUrl: String(settings.OllamaLLMBasePath ?? '').replace(/\/+$/, ''),
      stop: async () => {},
    },
  };
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', default: path.join(ROOT, 'scripts', 'eval', 'configs', 'default.json') },
      'corpus-label': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 2) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const corpusDir = path.resolve(positionals[0]!);
  const questionsFile = path.resolve(positionals[1]!);
  if (!fs.statSync(corpusDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no folder ${corpusDir}`);
  const config = loadConfig(values.config!, ROOT);
  const questions = loadQuestions(questionsFile);
  // A folder named corpus is labelled by its parent, so test/fixtures/eval-s/corpus becomes eval-s.
  const corpusLabel =
    values['corpus-label'] ??
    path.basename(path.basename(corpusDir) === 'corpus' ? path.dirname(corpusDir) : corpusDir);
  const started = new Date();
  const runId = `${stamp(started)}-${corpusLabel}-${config.label}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const outDir = path.resolve(values.out ?? path.join(ROOT, 'eval-runs', runId));
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, 'results.csv');
  const runFile = path.join(outDir, 'run.json');

  const corpusFiles = new Set(
    fs
      .readdirSync(corpusDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name.normalize('NFC').toLowerCase()),
  );
  for (const q of questions) {
    for (const f of listOf(q.expected_source_file)) {
      if (!corpusFiles.has(f.normalize('NFC').toLowerCase()))
        log(`warning: question ${q.id} expects ${f}, which is not in the corpus`);
    }
  }

  const run: Record<string, unknown> = {
    runId,
    status: 'running',
    startedAt: started.toISOString(),
    endedAt: null,
    upstreamVersion: fs.readFileSync(path.join(ROOT, 'UPSTREAM_VERSION'), 'utf8').trim(),
    gitCommit: gitCommit(),
    corpus: { label: corpusLabel, path: corpusDir },
    questions: { path: questionsFile, count: questions.length },
    config: redact(config),
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? null,
      totalMemGb: Math.round(os.totalmem() / 2 ** 30),
      node: process.version,
    },
  };
  const save = () => fs.writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  save();
  log(`run ${runId} -> ${outDir}`);

  let stack: Stack | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    log(`${sig}: stopping`);
    run.status = `interrupted (${sig})`;
    run.endedAt = new Date().toISOString();
    save();
    void (stack?.stop() ?? Promise.resolve()).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    let apiKey: string;
    if (config.baseUrl) {
      ({ stack, apiKey } = await connectExternal(config));
      run.server = { mode: 'external', baseUrl: config.baseUrl };
    } else {
      stack = await startManaged(ROOT, config, path.join(outDir, 'logs'));
      apiKey = await generateApiKey({ baseUrl: stack.baseUrl, name: 'askfiles-eval' });
      run.server = {
        mode: 'managed',
        baseUrl: stack.baseUrl,
        dataDir: config.dataDir,
        logs: path.join(outDir, 'logs'),
      };
    }
    const client = createClient({ baseUrl: stack.baseUrl, apiKey });
    run.ollama = await ollamaInfo(stack.ollamaUrl, [config.chatModel, config.embeddingModel]);
    save();

    const removeDocuments = async (names: string[]) => {
      const r = await fetch(`${stack!.baseUrl}/api/v1/system/remove-documents`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ names }),
      });
      if (!r.ok) log(`could not remove OCR upload ${names.join(', ')}: ${r.status}`);
    };
    const library: Library = await prepareLibrary({
      client: client as unknown as LibraryClient,
      removeDocuments,
      config,
      corpusDir,
      storageDir: stack.storageDir,
      log,
    });
    run.library = { workspace: library.workspaceName, slug: library.slug, ...library.stats, files: library.files };
    save();
    log(
      `library: ${library.stats.chunks} chunks from ${library.stats.files} files; ${library.stats.added} embedded in ${library.stats.embedMs} ms, ${library.stats.reused} reused`,
    );

    // Loads the chat model so the first question's latency does not include it. Chat mode, since
    // query mode refuses without calling the model when nothing matches.
    const warm = await ask(client, library.slug, { ...config, chatMode: 'chat' }, 'Reply with the single word OK.');
    run.warmup = { totalMs: warm.totalMs, error: warm.error || null };
    save();

    fs.writeFileSync(resultsFile, csvHeader([...RESULT_COLUMNS]));
    let errors = 0;
    for (let pass = 1; pass <= config.passes; pass++) {
      for (const [i, q] of questions.entries()) {
        const outcome = await ask(client, library.slug, config, q.question);
        let fallback: SourceRecord[] = [];
        const refused =
          !outcome.error && isNothingFound({ text: outcome.text, sources: outcome.sources }, REFUSAL_TEXT);
        if (refused) {
          // What the search page shows when nothing is found: the nearest sections at any score.
          try {
            const raw = await client.vectorSearch(library.slug, q.question, {
              topN: FALLBACK_TOP_N,
              scoreThreshold: 0,
            });
            fallback = resolveFallback(raw as Record<string, unknown>[], library.chunkIndex);
          } catch (e) {
            log(`vector-search failed for ${q.id}: ${(e as Error).message}`);
          }
        }
        if (outcome.error) errors++;
        const row = resultRow({ runId, corpus: corpusLabel, pass, q, outcome, fallback });
        fs.appendFileSync(resultsFile, csvLine(RESULT_COLUMNS.map((c) => row[c])));
        log(
          `pass ${pass} ${i + 1}/${questions.length} ${q.id} ${q.category}: ${row.refused === 'yes' ? 'refused' : `${outcome.sources.length} source(s)`}, ` +
            `first token ${outcome.firstTokenMs ?? '-'} ms, total ${outcome.totalMs} ms${outcome.error ? `, error ${outcome.error}` : ''}`,
        );
      }
    }
    run.status = errors ? `completed with ${errors} error row(s)` : 'completed';
    run.rows = questions.length * config.passes;
  } catch (e) {
    run.status = `failed: ${(e as Error).message}`;
    throw e;
  } finally {
    run.endedAt = new Date().toISOString();
    save();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await stack?.stop();
  }
  log(`done: ${resultsFile}`);
  return 0;
}

// Guarded so tests can import this module, where require is not defined.
if (typeof require !== 'undefined' && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(`[eval] ${e.message}`);
      process.exit(1);
    },
  );
}
