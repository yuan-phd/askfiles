// Prints per-category deltas between two run folders (B minus A). Usage: docs/eval.md.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatComparison, summarize } from './aggregate.js';
import { readRun } from './results.js';

const USAGE = `usage: npm run eval:compare -- <run folder A> <run folder B>

Scores are read as in eval:score: <run>/scored.csv, else the score column of <run>/results.csv.`;

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' } },
  });
  if (values.help || positionals.length !== 2) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const [a, b] = positionals.map((dir) => readRun(path.resolve(dir)));
  const title = (r: typeof a) => {
    const c = r!.info.config;
    return `${r!.info.runId} (corpus ${r!.info.corpus}; ${c.label}: ${c.chatModel}, ${c.embeddingModel}, threshold ${c.similarityThreshold}, snippets ${c.topN}, chunk maximum ${c.chunkMax}, rerank ${c.rerank ? 'on' : 'off'})`;
  };
  if (a!.info.corpus !== b!.info.corpus) {
    console.log(
      `Warning: the runs use different corpora (${a!.info.corpus}, ${b!.info.corpus}); deltas mix corpus and configuration.\n`,
    );
  }
  console.log(
    formatComparison(
      { title: title(a), summary: summarize(a!.rows) },
      { title: title(b), summary: summarize(b!.rows) },
    ),
  );
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
