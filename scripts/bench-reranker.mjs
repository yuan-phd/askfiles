// Times the rerankers of config/presets.json on the machine it runs on, through the shell's own
// code (dist/main/answer: ensureReranker, crossEncoder) and the server's @xenova/transformers.
// The mac workflow runs it on the CI Mac; docs/plan.md records the numbers.
// Each model runs in its own child process, so the memory figure is that model's alone.
// Usage: node scripts/bench-reranker.mjs <models dir> [repo ...]   (after npm run build:main)
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { crossEncoder, ensureReranker, rerankerBytes, rerankerModel } = await import(
  pathToFileURL(path.join(ROOT, 'dist', 'main', 'answer', 'index.js')).href
);

const [modelsDir, ...repos] = process.argv.slice(2);
if (!modelsDir) {
  console.error('usage: node scripts/bench-reranker.mjs <models dir> [repo ...]');
  process.exit(2);
}
const models = repos.length
  ? repos
  : ['Xenova/ms-marco-MiniLM-L-6-v2', 'Xenova/bge-reranker-base', 'onnx-community/bge-reranker-v2-m3-ONNX'];

// Sections long enough to reach the 512-token limit, half English, half Chinese, as a mixed library gives.
const EN = 'The employee handbook describes leave, travel, expenses and conduct rules for all staff members. '.repeat(
  30,
);
const ZH = '员工手册规定了全体员工的休假、差旅、报销和行为规范，各部门应当遵照执行。'.repeat(40);
const QUESTION = 'How many days of paid annual leave do employees get per year?';
const PAIRS = [
  ['Employees receive 27 days of paid annual leave per year.', 'The office opens at nine.'],
  ['员工每年享有二十七天带薪年假。', '停车场位于地下二层。'],
];
const REPEATS = 3;

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

async function benchOne(repo) {
  const m = rerankerModel(repo);
  const t0 = performance.now();
  await ensureReranker({ repo, modelsDir, log: (msg) => console.error(`[bench] ${msg}`) });
  const fetchMs = Math.round(performance.now() - t0);
  const r = crossEncoder({
    transformersDir: path.join(ROOT, 'upstream', 'server', 'node_modules', '@xenova', 'transformers'),
    modelsDir,
    repo,
  });
  const t1 = performance.now();
  const en = await r.score('How many days of paid annual leave?', PAIRS[0]);
  const loadMs = Math.round(performance.now() - t1);
  const zh = await r.score('每年有多少天带薪年假？', PAIRS[1]);
  const timing = {};
  for (const n of [8, 12]) {
    const texts = Array.from({ length: n }, (_, i) => (i % 2 ? ZH : EN));
    const times = [];
    for (let k = 0; k < REPEATS; k++) {
      const s = performance.now();
      await r.score(QUESTION, texts);
      times.push(Math.round(performance.now() - s));
    }
    timing[n] = median(times);
  }
  return {
    label: m.label,
    mb: (rerankerBytes(m) / 1e6).toFixed(0),
    fetchMs,
    loadMs,
    ms8: timing[8],
    ms12: timing[12],
    rssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
    en: `${en[0].toFixed(3)} / ${en[1].toFixed(3)}`,
    zh: `${zh[0].toFixed(3)} / ${zh[1].toFixed(3)}`,
  };
}

if (models[0] === '--one') {
  console.log(JSON.stringify(await benchOne(models[1])));
  process.exit(0);
}

const rows = [];
for (const repo of models) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), modelsDir, '--one', repo], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  rows.push(JSON.parse(out.trim().split('\n').pop()));
  console.log(`[bench] ${JSON.stringify(rows[rows.length - 1])}`);
}

console.log(`\n${process.platform} ${process.arch}, Node ${process.version}, ${REPEATS} runs per size, median\n`);
console.log(
  '| Reranker | Files | First load and first call | 8 sections | 12 sections | Process RSS | English answer / unrelated | Chinese answer / unrelated |',
);
console.log('|---|---|---|---|---|---|---|---|');
for (const x of rows) {
  console.log(
    `| ${x.label} | ${x.mb} MB | ${x.loadMs} ms | ${x.ms8} ms | ${x.ms12} ms | ${x.rssMb} MB | ${x.en} | ${x.zh} |`,
  );
}
