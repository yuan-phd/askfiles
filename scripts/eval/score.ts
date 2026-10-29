// Prints the owner's scores per category and the citation, section and latency measures for one
// or more run folders, grouped by corpus, then a Markdown table for docs/plan.md. Usage: docs/eval.md.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatReport, markdownTable, summarize, type TableRun } from './aggregate.js';
import { readRun } from './results.js';

const USAGE = `usage: npm run eval:score -- <run folder> [<run folder> ...] [--scores scored.csv]

Scores come from --scores (one run folder only), else <run>/scored.csv, else the score column of
<run>/results.csv. Values: correct, partial, wrong, refused, hallucinated.`;

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
  if (values.scores && positionals.length > 1) throw new Error('--scores applies to a single run folder');
  const runs = positionals.map((dir) => readRun(path.resolve(dir), values.scores && path.resolve(values.scores)));
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
