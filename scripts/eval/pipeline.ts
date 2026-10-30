// The shell's answer pipeline (src/main/answer) run by the eval harness, in two stages so a tuning
// loop takes minutes: stage 1 runs candidates, fusion and reranking once per question, caches the
// result on disk and sweeps section count and rerank floor without the model; stage 2 runs the
// model for the configurations the owner names. Usage: docs/eval.md.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  answer,
  choose,
  rerankerProcess,
  ensureReranker,
  ollamaChat,
  NEAREST_COUNT,
  ranked,
  retrieve,
  upstreamVectorSearch,
  type AnswerResult,
  type AnswerSection,
  type PipelineDeps,
  type Retrieval,
  type RunSettings,
  type SourceCard,
} from '../../src/main/answer/index.js';
import { BrowseIndex, chunkReader } from '../../src/main/browse/index.js';
import { createSourceResolver } from '../../src/main/watcher/index.js';
import { readSectionText } from '../../src/main/watcher/section-docs.js';
import {
  attributionOk,
  expectedSections,
  keyCoverage,
  sectionMatches,
  targetHit,
  type CitedRecord,
} from './answer-metrics.js';
import type { EvalConfig } from './config.js';
import type { Library } from './library.js';
import type { Question } from './questions.js';

/** Context length when the config leaves contextTokens at 0, as the presets set it. */
export const DEFAULT_CONTEXT = 8192;
export const DEFAULT_COUNTS = [1, 2, 3, 4, 5, 6];
export const DEFAULT_FLOORS = [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7];

export function runSettings(
  config: EvalConfig,
  chunkMaxChars: number,
  o: { count?: number; floor?: number } = {},
): RunSettings {
  const params = structuredClone(config.answer);
  if (o.count !== undefined) params.sectionCount[config.scope] = o.count;
  if (o.floor !== undefined) params.rerankFloor[config.scope] = o.floor;
  return {
    params,
    scope: config.scope,
    chatModel: config.chatModel,
    contextLength: config.contextTokens || DEFAULT_CONTEXT,
    chunkMaxChars,
    temperature: config.temperature,
  };
}

/** Everything a stage 1 result depends on, so a cached retrieval is reused only when all of it is unchanged. */
export function indexHash(config: EvalConfig, library: Pick<Library, 'records'>): string {
  const p = config.answer;
  const key = {
    locations: library.records.flatMap((r) => r.sections.map((s) => s.location)).sort(),
    embeddingModel: config.embeddingModel,
    chunkMax: config.chunkMax,
    retrieval: [
      p.rerankerModel,
      p.rerankerBypassCjk,
      p.vectorTopK,
      p.keywordTopK,
      p.rrfK,
      p.candidateSections,
      p.sectionCapChars,
    ],
  };
  return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16);
}

export function cardRecord(
  c: Pick<SourceCard, 'file' | 'path' | 'title' | 'pageStart' | 'pageEnd' | 'passage'>,
): CitedRecord {
  return { file: c.file, path: c.path, title: c.title, pageStart: c.pageStart, pageEnd: c.pageEnd, passage: c.passage };
}

export function describeCards(cards: { file: string; path: string[]; rerank?: number | null; n?: number }[]): string {
  return cards
    .map(
      (c, i) =>
        `${c.n ?? i + 1}. ${c.file} | ${c.path.join(' > ')}${typeof c.rerank === 'number' ? ` | ${c.rerank.toFixed(3)}` : ''}`,
    )
    .join('\n');
}

export async function buildPipeline(o: {
  root: string;
  config: EvalConfig;
  library: Library;
  corpusDir: string;
  storageDir: string;
  baseUrl: string;
  ollamaUrl: string;
  apiKey: string;
  workDir: string;
  log: (msg: string) => void;
}): Promise<PipelineDeps> {
  const index = new BrowseIndex({
    dir: path.join(o.workDir, 'browse'),
    root: o.corpusDir,
    readChunk: chunkReader(o.storageDir),
    log: () => {},
  });
  index.sync(o.library.records);
  const resolver = createSourceResolver({
    files: () => o.library.records,
    readText: (l) => readSectionText(o.storageDir, l),
  });
  const repo = o.config.answer.rerankerModel;
  await ensureReranker({ repo, modelsDir: o.config.rerankerDir, log: o.log });
  const reranker = rerankerProcess({
    transformersDir: path.join(o.root, 'upstream', 'server', 'node_modules', '@xenova', 'transformers'),
    modelsDir: o.config.rerankerDir,
    repo,
    log: o.log,
  });
  return {
    vectorSearch: upstreamVectorSearch({ baseUrl: () => o.baseUrl, apiKey: o.apiKey, slug: o.library.slug }),
    resolveSources: (s) => resolver(s),
    index,
    reranker,
    chat: ollamaChat(() => o.ollamaUrl),
  };
}

/** Stage 1 for one question, from the cache when the question and the index hash match. */
export async function cachedRetrieve(
  question: string,
  s: RunSettings,
  deps: PipelineDeps,
  cacheDir: string,
): Promise<{ retrieval: Retrieval; cached: boolean }> {
  const file = path.join(cacheDir, `${createHash('sha256').update(question).digest('hex').slice(0, 24)}.json`);
  try {
    const hit = JSON.parse(fs.readFileSync(file, 'utf8')) as Retrieval;
    if (hit.question === question) return { retrieval: hit, cached: true };
  } catch {
    // Not cached yet.
  }
  const retrieval = await retrieve(question, s, deps);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(retrieval));
  return { retrieval, cached: false };
}

export interface SweepCell {
  count: number;
  floor: number;
  /** Questions whose expected sections were all selected, over questions that name one. */
  hit: number;
  n: number;
  /** Absent questions where no section passed the floor, over absent questions. */
  emptyAbsent: number;
  nAbsent: number;
}

/** Target-section hit rate per section count and rerank floor, from cached retrievals only. */
export function sweep(
  items: { q: Question; retrieval: Retrieval }[],
  config: EvalConfig,
  chunkMaxChars: number,
  counts: number[],
  floors: number[],
): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const count of counts) {
    for (const floor of floors) {
      const cell: SweepCell = { count, floor, hit: 0, n: 0, emptyAbsent: 0, nAbsent: 0 };
      for (const { q, retrieval } of items) {
        const s = runSettings(config, chunkMaxChars, { count, floor });
        const hit = targetHit(q, stage1Sections(q, retrieval, s));
        if (hit !== null) {
          cell.n++;
          if (hit) cell.hit++;
        }
        if (q.category.startsWith('absent')) {
          cell.nAbsent++;
          if (!choose(retrieval, s).selected.length) cell.emptyAbsent++;
        }
      }
      cells.push(cell);
    }
  }
  return cells;
}

export function sweepTable(cells: SweepCell[], mark: { count: number; floor: number }): string {
  const counts = [...new Set(cells.map((c) => c.count))];
  const floors = [...new Set(cells.map((c) => c.floor))];
  const at = (count: number, floor: number) => cells.find((c) => c.count === count && c.floor === floor)!;
  const fmt = (c: SweepCell) => {
    const v = c.n ? `${Math.round((100 * c.hit) / c.n)}%` : '-';
    return c.count === mark.count && c.floor === mark.floor ? `**${v}**` : v;
  };
  const lines = [
    `| Sections \\ floor | ${floors.join(' | ')} |`,
    `|---|${floors.map(() => '---').join('|')}|`,
    ...counts.map((n) => `| ${n} | ${floors.map((f) => fmt(at(n, f))).join(' | ')} |`),
  ];
  const absent = cells.filter((c) => c.count === counts[0]);
  if (absent[0]?.nAbsent) {
    lines.push(
      '',
      `Absent questions with no section above the floor: ${floors
        .map((f) => {
          const c = at(counts[0]!, f);
          return `${f}: ${c.emptyAbsent}/${c.nAbsent}`;
        })
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * The sections a question is measured against without the model. For section_listing the correct
 * output is the no-answer state listing the nearest sections, which takes the best reranked
 * sections with no floor; for every other category, the selected sections.
 */
export function stage1Sections(q: Question, r: Retrieval, s: RunSettings): AnswerSection[] {
  if (q.category === 'section_listing')
    return ranked(r)
      .slice(0, NEAREST_COUNT)
      .map((x) => x.section);
  return choose(r, s).selected.map((x) => x.section);
}

/** Rank (1-based) and rerank score of the first expected section in the final order, or null. */
export function expectedRank(q: Question, r: Retrieval): { rank: number; rerank: number | null } | null {
  const want = expectedSections(q)[0];
  if (!want) return null;
  const i = ranked(r).findIndex((x) => sectionMatches(want, x.section));
  return i < 0 ? null : { rank: i + 1, rerank: ranked(r)[i]!.rerank };
}

export interface AnswerRow {
  result: AnswerResult | null;
  error: string;
  totalMs: number;
}

export async function answerOnce(
  q: Question,
  retrieval: Retrieval,
  s: RunSettings,
  deps: PipelineDeps,
): Promise<AnswerRow> {
  const t0 = performance.now();
  try {
    const result = await answer(q.question, retrieval, choose(retrieval, s), s, deps);
    const t = retrieval.timings;
    return { result, error: '', totalMs: Math.round(t.vectorMs + t.keywordMs + t.rerankMs + (performance.now() - t0)) };
  } catch (e) {
    return { result: null, error: (e as Error).message, totalMs: Math.round(performance.now() - t0) };
  }
}

/**
 * The three metrics of one answer. A section_listing question answered with the no-answer state
 * is measured on the listed sections: target hit when they include the expected ones, coverage
 * of the key elements in their paths, attribution correct when the target is listed.
 */
export function answerMetrics(q: Question, row: AnswerRow) {
  const r = row.result;
  if (!r) return { targetHit: null, keyCoverage: null, attribution: null };
  if (q.category === 'section_listing' && r.notFound) {
    const listed = r.nearest.map(cardRecord);
    const hit = targetHit(q, listed);
    return {
      targetHit: hit,
      keyCoverage: keyCoverage(q, listed.map((c) => c.path.join(' > ')).join('\n')),
      attribution: hit,
    };
  }
  const cited = r.cited.map(cardRecord);
  return {
    targetHit: targetHit(q, cited),
    keyCoverage: r.notFound ? (keyCoverage(q, '') === null ? null : 0) : keyCoverage(q, r.text),
    attribution: attributionOk(q, { refused: r.notFound, cited }),
  };
}
