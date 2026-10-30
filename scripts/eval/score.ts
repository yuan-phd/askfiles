// Prints, per run folder: for the answer pipeline, the target section hit, key element coverage,
// attribution accuracy and latency per configuration and category (stage 2) or the stage 1 sweep;
// for the upstream route, the same three metrics plus the owner's scores per category and the
// citation measures, then a Markdown table for docs/plan.md. Usage: docs/eval.md.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatReport, markdownTable, summarize, type TableRun } from './aggregate.js';
import {
  attributionOk,
  keyCoverage,
  metricsTable,
  summarizeMetrics,
  targetHit,
  type CitedRecord,
  type MetricRow,
} from './answer-metrics.js';
import { parseRecords } from './csv.js';
import type { SourceRecord } from './metrics.js';
import { sweepTable, type SweepCell } from './pipeline.js';
import type { Question } from './questions.js';
import { readRun } from './results.js';

const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : Number(v));
const bool = (v: string | undefined) => (v === 'yes' ? true : v === 'no' ? false : null);

/**
 * Metric rows from a results.csv. Pipeline rows carry the metrics already; upstream rows get them
 * computed here, with the sources the server returned standing in for the cited sections.
 */
export function metricRowsOf(csv: string, mode: string): MetricRow[] {
  return parseRecords(csv).records.map((r) => {
    if (mode === 'pipeline-answer') {
      return {
        id: r.id ?? '',
        category: r.category ?? '',
        config: r.config ?? '',
        targetHit: bool(r.target_hit),
        keyCoverage: num(r.key_coverage),
        attribution: bool(r.attribution_ok),
        firstTokenMs: num(r.first_token_ms),
        totalMs: r.error ? null : num(r.total_ms),
      };
    }
    const q = r as unknown as Question;
    const sources = r.sources_json?.trim() ? (JSON.parse(r.sources_json) as SourceRecord[]) : [];
    const cited: CitedRecord[] = sources.map((x) => ({
      file: x.file,
      path: x.sectionTitle ? [x.sectionTitle] : [],
      title: x.sectionTitle ?? '',
      pageStart: x.page,
      pageEnd: x.pageEnd,
      passage: x.passage,
    }));
    const refused = r.refused === 'yes';
    return {
      id: r.id ?? '',
      category: r.category ?? '',
      config: 'upstream',
      targetHit: refused ? targetHit(q, []) : targetHit(q, cited),
      keyCoverage: keyCoverage(q, refused ? '' : (r.answer ?? '')),
      attribution: attributionOk(q, { refused, cited }),
      firstTokenMs: num(r.first_token_ms),
      totalMs: r.error ? null : num(r.total_ms),
    };
  });
}

const USAGE = `usage: npm run eval:score -- <run folder> [<run folder> ...] [--scores scored.csv]

Every run gets target section hit, key element coverage, attribution accuracy and latency per
configuration and category (a stage 1 run its sweep table). Upstream route runs also get the
owner's scores: from --scores (one upstream run only), else <run>/scored.csv, else the score column
of <run>/results.csv. Values: correct, partial, wrong, refused, hallucinated.`;

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { scores: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help || !positionals.length) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const upstreamDirs: string[] = [];
  for (const dir of positionals.map((d) => path.resolve(d))) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as Record<string, unknown>;
    const mode = String(json.mode ?? 'upstream');
    console.log(`\n## ${String(json.runId ?? path.basename(dir))} (${mode})\n`);
    if (mode === 'pipeline-retrieval') {
      const s1 = json.stage1 as
        { sweep: SweepCell[]; mark: { count: number; floor: number }; scope: string } | undefined;
      if (s1) console.log(`Target section hit rate, scope ${s1.scope}\n\n${sweepTable(s1.sweep, s1.mark)}`);
      continue;
    }
    const rows = metricRowsOf(fs.readFileSync(path.join(dir, 'results.csv'), 'utf8'), mode);
    console.log(metricsTable(summarizeMetrics(rows)));
    if (mode !== 'pipeline-answer') upstreamDirs.push(dir);
  }
  if (!upstreamDirs.length) return 0;
  if (values.scores && upstreamDirs.length > 1) throw new Error('--scores applies to a single run folder');
  const runs = upstreamDirs.map((dir) => readRun(dir, values.scores && path.resolve(values.scores)));
  const corpora = [...new Set(runs.map((r) => r.info.corpus))];
  const table: TableRun[] = [];
  for (const corpus of corpora) {
    console.log(`\n## Corpus ${corpus || '(unnamed)'}\n`);
    for (const r of runs.filter((x) => x.info.corpus === corpus)) {
      const summary = summarize(r.rows);
      const c = r.info.config;
      const title =
        `### ${r.info.runId}\n\n${c.label}: chat ${c.chatModel}, embedder ${c.embeddingModel}, threshold ${c.similarityThreshold}, ` +
        `snippets ${c.topN}, chunk maximum ${c.chunkMax}, rerank ${c.rerank ? 'on' : 'off'}, ${c.passes} pass(es). Scores from ${r.scoreSource}`;
      console.log(formatReport(title, summary));
      if (summary.unscored)
        console.log(`Note: ${summary.unscored} row(s) have no score yet and are left out of the rates.`);
      console.log('');
      table.push({ corpus, label: String(c.label ?? ''), chatModel: String(c.chatModel ?? ''), summary });
    }
  }
  console.log('## Table for docs/plan.md\n');
  console.log(markdownTable(table));
  return 0;
}

if (typeof require !== 'undefined' && require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`[eval] ${(e as Error).message}`);
    process.exit(1);
  }
}
