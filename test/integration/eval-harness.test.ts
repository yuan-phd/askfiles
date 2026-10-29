// Runs the evaluation harness end to end on both fixtures with the cloud test models, in a fresh
// data directory, one pass each, then scores the runs. Needs RUN_INTEGRATION=1, ollama with
// qwen3:0.6b and all-minilm, and the upstream packages installed. Answer quality is not checked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRecords } from '../../scripts/eval/csv.js';
import { main as runMain } from '../../scripts/eval/run.js';
import { main as scoreMain } from '../../scripts/eval/score.js';
import { RESULT_COLUMNS } from '../../scripts/eval/results.js';
import { loadConfig } from '../../scripts/eval/config.js';
import { managedSkipReason } from '../../scripts/eval/stack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SMOKE = path.join(ROOT, 'scripts', 'eval', 'configs', 'smoke.json');

function skipReason(): string | null {
  if (process.env.RUN_INTEGRATION !== '1') return 'RUN_INTEGRATION is not 1';
  return managedSkipReason(ROOT, loadConfig(SMOKE, ROOT));
}

const reason = skipReason();
// Written to stderr because vitest does not show console output from test collection.
if (reason) process.stderr.write(`[integration] eval-harness skipped: ${reason}\n`);

describe.skipIf(reason !== null)('evaluation harness with the real stack', () => {
  it('runs both fixtures end to end and scores them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-eval-it-'));
    const config = path.join(dir, 'config.json');
    const smoke = JSON.parse(fs.readFileSync(SMOKE, 'utf8'));
    fs.writeFileSync(config, JSON.stringify({ ...smoke, passes: 1, dataDir: path.join(dir, 'data') }));

    for (const corpus of ['eval-s', 'eval-l']) {
      const out = path.join(dir, corpus);
      const fixture = path.join(ROOT, 'test', 'fixtures', corpus);
      const code = await runMain([
        path.join(fixture, 'corpus'),
        path.join(fixture, 'questions.csv'),
        '--config',
        config,
        '--out',
        out,
      ]);
      expect(code).toBe(0);
      const run = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
      const questions = parseRecords(fs.readFileSync(path.join(fixture, 'questions.csv'), 'utf8')).records;
      const { header, records } = parseRecords(fs.readFileSync(path.join(out, 'results.csv'), 'utf8'));
      console.log(
        `[integration] ${corpus}: ${run.status}, ${run.library.chunks} chunks, embed ${run.library.embedMs} ms, ${records.length} rows`,
      );
      expect(run.status).toBe('completed');
      expect(run.upstreamVersion).toMatch(/^v\d/);
      expect(run.corpus.label).toBe(corpus);
      expect(Object.keys(run.ollama.models)).toEqual([smoke.chatModel, smoke.embeddingModel]);
      expect(run.ollama.models[smoke.chatModel].digest).toMatch(/^[0-9a-f]{64}$/);
      expect(run.library.added).toBe(run.library.chunks);
      expect(header).toEqual([...RESULT_COLUMNS]);
      expect(records.map((r) => r.id)).toEqual(questions.map((q) => q.id));
      expect(records.every((r) => !r.error && Number(r.total_ms) > 0)).toBe(true);
      expect(records.some((r) => r.sources_json.includes('"sectionTitle"'))).toBe(true);
    }
    const l = parseRecords(fs.readFileSync(path.join(dir, 'eval-l', 'results.csv'), 'utf8')).records;
    expect(l.some((r) => r.sources.includes('1.1 Receiving goods'))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'eval-l', 'run.json'), 'utf8')).library.files[0].splitSections,
    ).toBeGreaterThan(0);

    // Score the S run as the owner would and check the report reads it.
    const s = path.join(dir, 'eval-s');
    const ids = parseRecords(fs.readFileSync(path.join(s, 'results.csv'), 'utf8')).records.map((r) => r.id);
    fs.writeFileSync(path.join(s, 'scored.csv'), `id,score\n${ids.map((id) => `${id},partial`).join('\n')}\n`);
    expect(scoreMain([s, path.join(dir, 'eval-l')])).toBe(0);
  }, 900_000);
});
