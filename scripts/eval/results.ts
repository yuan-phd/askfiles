import fs from 'node:fs';
import path from 'node:path';
import { parseRecords } from './csv.js';
import type { SourceRecord } from './metrics.js';

export const RESULT_COLUMNS = [
  'run_id',
  'corpus',
  'pass',
  'id',
  'category',
  'question',
  'expected_answer',
  'expected_source_file',
  'expected_section',
  'expected_section_path',
  'expected_page',
  'key_elements',
  'notes',
  'answer',
  'refused',
  'thinking',
  'sources',
  'file_hit',
  'section_hit',
  'page_hit',
  'section_recall',
  'fallback_sections',
  'first_token_ms',
  'total_ms',
  'prompt_tokens',
  'completion_tokens',
  'chat_id',
  'error',
  'sources_json',
  'fallback_json',
  'score',
  'score_note',
] as const;

const QUESTION_FIELDS = [
  'id',
  'category',
  'question',
  'expected_answer',
  'expected_source_file',
  'expected_section',
  'expected_section_path',
  'expected_page',
  'key_elements',
] as const;

/** Stage 1 of the pipeline eval: one row per question, no model. */
export const RETRIEVAL_COLUMNS = [
  'run_id',
  'corpus',
  ...QUESTION_FIELDS,
  'terms',
  'bypass',
  'candidates',
  'expected_rank',
  'expected_rerank',
  'selected',
  'target_hit',
  'cached',
  'vector_ms',
  'keyword_ms',
  'rerank_ms',
] as const;

/** Stage 2 of the pipeline eval: one row per configuration, pass and question. */
export const ANSWER_COLUMNS = [
  'run_id',
  'corpus',
  'config',
  'pass',
  ...QUESTION_FIELDS,
  'answer',
  'not_found',
  'skipped_model',
  'cited',
  'considered',
  'unsupported_sentences',
  'target_hit',
  'key_coverage',
  'attribution_ok',
  'first_token_ms',
  'model_ms',
  'total_ms',
  'prompt_tokens',
  'completion_tokens',
  'error',
  'cited_json',
] as const;

export const SCORES = ['correct', 'partial', 'wrong', 'refused', 'hallucinated'] as const;
export type Score = (typeof SCORES)[number];

export interface ResultRow {
  id: string;
  pass: number;
  category: string;
  expected_source_file: string;
  expected_section: string;
  expected_page: string;
  refused: boolean;
  sources: SourceRecord[];
  fallback: SourceRecord[];
  firstTokenMs: number | null;
  totalMs: number | null;
  error: string;
  score: Score | null;
}

export interface RunInfo {
  dir: string;
  runId: string;
  corpus: string;
  label: string;
  config: Record<string, unknown>;
  json: Record<string, unknown>;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function sourcesOf(s: string | undefined): SourceRecord[] {
  if (!s || !s.trim()) return [];
  return JSON.parse(s) as SourceRecord[];
}

/**
 * Reads the owner's scores into the rows. A scores file may be results.csv itself with the score
 * column filled in, or any CSV with id, score and optionally pass columns; without a pass column a
 * score applies to every pass of that id. Throws on values outside SCORES.
 */
export function applyScores(rows: ResultRow[], scoresCsv: string): { unknownIds: string[] } {
  const { header, records } = parseRecords(scoresCsv);
  if (!header.includes('id') || !header.includes('score')) throw new Error('scores CSV needs id and score columns');
  const byPass = header.includes('pass');
  const scores = new Map<string, Score>();
  const bad: string[] = [];
  for (const r of records) {
    const v = (r.score ?? '').trim().toLowerCase();
    if (!v) continue;
    if (!(SCORES as readonly string[]).includes(v)) bad.push(`${r.id}: ${JSON.stringify(r.score)}`);
    const key = byPass && (r.pass ?? '').trim() ? `${r.id}\u0000${r.pass!.trim()}` : `${r.id}`;
    scores.set(key, v as Score);
  }
  if (bad.length) throw new Error(`scores must be one of ${SCORES.join(', ')}; found ${bad.join('; ')}`);
  const ids = new Set(rows.map((r) => r.id));
  for (const row of rows) row.score = scores.get(`${row.id}\u0000${row.pass}`) ?? scores.get(row.id) ?? null;
  const unknownIds = [...new Set([...scores.keys()].map((k) => k.split('\u0000')[0]!))].filter((id) => !ids.has(id));
  return { unknownIds };
}

export function parseResults(csv: string): ResultRow[] {
  return parseRecords(csv).records.map((r) => ({
    id: r.id ?? '',
    pass: num(r.pass) ?? 1,
    category: r.category ?? '',
    expected_source_file: r.expected_source_file ?? '',
    expected_section: r.expected_section ?? '',
    expected_page: r.expected_page ?? '',
    refused: r.refused === 'yes',
    sources: sourcesOf(r.sources_json),
    fallback: sourcesOf(r.fallback_json),
    firstTokenMs: num(r.first_token_ms),
    totalMs: num(r.total_ms),
    error: r.error ?? '',
    score: null,
  }));
}

/**
 * A run folder: run.json and results.csv, with scores from scoresFile, else from scored.csv in the
 * folder, else from the score column of results.csv.
 */
export function readRun(dir: string, scoresFile?: string): { info: RunInfo; rows: ResultRow[]; scoreSource: string } {
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as Record<string, unknown>;
  const resultsCsv = fs.readFileSync(path.join(dir, 'results.csv'), 'utf8');
  const rows = parseResults(resultsCsv);
  const scored = scoresFile ?? (fs.existsSync(path.join(dir, 'scored.csv')) ? path.join(dir, 'scored.csv') : null);
  const { unknownIds } = applyScores(rows, scored ? fs.readFileSync(scored, 'utf8') : resultsCsv);
  if (unknownIds.length) console.warn(`[eval] scores for ids not in ${dir}: ${unknownIds.join(', ')}`);
  const config = (json.config ?? {}) as Record<string, unknown>;
  return {
    info: {
      dir,
      runId: String(json.runId ?? path.basename(dir)),
      corpus: String((json.corpus as { label?: string } | undefined)?.label ?? ''),
      label: String(config.label ?? ''),
      config,
      json,
    },
    rows,
    scoreSource: scored ?? path.join(dir, 'results.csv'),
  };
}
