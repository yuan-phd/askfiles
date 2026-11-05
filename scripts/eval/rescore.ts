// Rescoring a recorded run without the chat model (docs/plan.md, round D1): every answer of a run
// folder goes through the answer stage again with the model's recorded reply in place of the chat
// call, on the run's cached retrieval and browse index, so verification and the metrics act on the
// same reply as in the run. Switches can be changed with --set; sentenceMatch embeds through Ollama.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { csvHeader, csvLine, parseCsv } from './csv.js';
import { applySets, type EvalConfig } from './config.js';
import { isUnsupported, loadQuestions } from './questions.js';
import { ANSWER_COLUMNS } from './results.js';
import { answerMetrics, answerOnce, literalElementsOf, runSettings } from './pipeline.js';
import { answerRow } from './run.js';
import { summarizeMetrics, metricsTable, type MetricRow } from './answer-metrics.js';
import {
  DEFAULT_PARAMS,
  ollamaEmbed,
  SentenceVectorCache,
  type AnswerDeps,
  type ChatFn,
  type PipelineDeps,
  type Retrieval,
} from '../../src/main/answer/index.js';
import { BrowseIndex } from '../../src/main/browse/browse-index.js';
import { createHash } from 'node:crypto';

const USAGE = `usage: npm run eval:rescore -- <recorded run folder> --out <folder> [--set k=v ...]

The recorded reply of each answer is raw_answer when the run has it, else the answer column (in runs
before raw_answer was recorded it is the reply as written unless hedges were dropped; then the
dropped hedges are put back in front). Timings are the recorded ones.`;

/** The reply as the model wrote it, from a results.csv row. */
export function recordedReply(row: Record<string, string>): string {
  if (row.raw_answer) return row.raw_answer;
  const hedges = (row.hedges_dropped ?? '').split(' | ').filter(Boolean);
  if (!hedges.length) return row.answer ?? '';
  // With hedges dropped the answer column is claimsText: citations after the full stop (.[1]),
  // which would join two sentences when parsed again; they go back before it, the hedges first
  // (their place in the reply is not recorded, and a sentence is verified on its own).
  const kept = (row.answer ?? '').replace(/\s*([.!?。！？]+)((?:\[\d+\])+)/gu, ' $2$1');
  return `${hedges.join(' ')} ${kept}`;
}

/** A chat function that writes the given reply. */
export function replayChat(
  reply: () => { text: string; promptTokens: number | null; completionTokens: number | null },
): ChatFn {
  return async (_o, onText) => {
    const r = reply();
    onText(r.text);
    return { promptTokens: r.promptTokens, completionTokens: r.completionTokens };
  };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, set: { type: 'string', multiple: true } },
  });
  const from = positionals[0];
  if (!from || !values.out) {
    console.error(USAGE);
    return 2;
  }
  const run = JSON.parse(fs.readFileSync(path.join(from, 'run.json'), 'utf8')) as {
    config: EvalConfig;
    questions: { path: string };
    retrievalCache: string;
  } & Record<string, unknown>;
  const recorded = run.config as EvalConfig;
  const config = applySets({ ...recorded, answer: { ...DEFAULT_PARAMS, ...recorded.answer } }, values.set ?? []);
  const questions = loadQuestions(run.questions.path);
  const table = parseCsv(fs.readFileSync(path.join(from, 'results.csv'), 'utf8').replace(/^\uFEFF/, ''));
  const head = table[0] ?? [];
  const rows = table
    .slice(1)
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])) as Record<string, string>);
  const index = new BrowseIndex({ dir: path.join(from, 'browse'), readChunk: () => null, log: () => {} });
  index.load();
  let current: Record<string, string> = {};
  const num = (v: string | undefined) => (v ? Number(v) : null);
  const embedMs: number[] = [];
  const deps: AnswerDeps = {
    chat: replayChat(() => ({
      text: recordedReply(current),
      promptTokens: num(current.prompt_tokens),
      completionTokens: num(current.completion_tokens),
    })),
    index,
    log: () => {},
    sentenceMatch: config.answer.sentenceMatch
      ? {
          embed: ollamaEmbed(() => `http://127.0.0.1:${config.ollamaPort}`, config.embeddingModel),
          model: config.embeddingModel,
          cache: new SentenceVectorCache(),
        }
      : null,
  };
  const literal = literalElementsOf(questions, index);
  const out = values.out;
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(path.join(from, 'browse'), path.join(out, 'browse'), { recursive: true });
  const resultsFile = path.join(out, 'results.csv');
  fs.writeFileSync(resultsFile, csvHeader([...ANSWER_COLUMNS]));
  const metricRows: MetricRow[] = [];
  for (const row of rows) {
    const q = questions.find((x) => x.id === row.id);
    if (!q) throw new Error(`question ${row.id} is not in ${run.questions.path}`);
    current = row;
    const file = path.join(
      run.retrievalCache,
      `${createHash('sha256').update(q.question).digest('hex').slice(0, 24)}.json`,
    );
    const retrieval = JSON.parse(fs.readFileSync(file, 'utf8')) as Retrieval;
    const [, count, floor] = /count=(\d+) floor=([\d.]+)/.exec(row.config ?? '') ?? [];
    const s = runSettings(config, config.chunkMax, {
      ...(count ? { count: Number(count) } : {}),
      ...(floor ? { floor: Number(floor) } : {}),
    });
    const answered = row.skipped_model !== 'yes';
    const res = await answerOnce(q, retrieval, s, deps as unknown as PipelineDeps);
    if (res.result && answered) {
      res.result.timings = { firstTokenMs: num(row.first_token_ms), modelMs: num(row.model_ms) ?? 0 };
    }
    res.totalMs = Number(row.total_ms) + (res.result?.sentenceMatch?.embedMs ?? 0);
    if (res.result?.sentenceMatch) embedMs.push(res.result.sentenceMatch.embedMs);
    const m = answerMetrics(q, res, literal.get(q.id)?.literal);
    const label = row.config ?? '';
    metricRows.push({
      id: q.id,
      category: q.category,
      config: label,
      targetHit: m.targetHit,
      keyCoverage: m.keyCoverage,
      attribution: m.attribution,
      firstTokenMs: res.result?.timings.firstTokenMs ?? null,
      totalMs: res.totalMs,
      refused: res.result ? res.result.notFound : null,
      unsupported: res.result ? res.result.claims.filter((x) => x.unsupported).length : null,
      excluded: isUnsupported(q),
    });
    const line = answerRow({
      runId: `${row.run_id}-rescored`,
      corpusLabel: row.corpus ?? '',
      label,
      pass: Number(row.pass || 1),
      q,
      retrieval,
      out: res,
      m,
    });
    fs.appendFileSync(resultsFile, csvLine(ANSWER_COLUMNS.map((k) => line[k])));
  }
  fs.writeFileSync(
    path.join(out, 'run.json'),
    JSON.stringify(
      {
        ...run,
        config: { ...config, apiKey: '' },
        rescoredFrom: path.resolve(from),
        rescoredAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(metricsTable(summarizeMetrics(metricRows).filter((x) => x.category === 'all')));
  if (embedMs.length) console.log(`embedding per answered question: ${embedMs.join(', ')} ms`);
  return 0;
}

if (typeof require !== 'undefined' && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(`[rescore] ${e.message}`);
      process.exit(1);
    },
  );
}
