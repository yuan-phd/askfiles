// The three answer metrics of docs/eval.md, computed without a human: target section hit, key
// element coverage and attribution accuracy. Pure functions over a question and what the
// pipeline (or the upstream route) cited.
import { normalizeName } from './metrics.js';
import { ABSENT, listOf, type Question } from './questions.js';

/** A section an answer cited, as results.csv records it (cited_json). */
export interface CitedRecord {
  file: string;
  path: string[];
  title: string;
  pageStart: number | null;
  pageEnd: number | null;
  /** The text the model read for this source. */
  passage: string;
}

export type MetricQuestion = Pick<
  Question,
  'category' | 'expected_source_file' | 'expected_section' | 'expected_section_path' | 'key_elements'
>;

/** Lower case, NFKC, no whitespace at all: how key elements are looked for. */
export function squash(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

const PATH_SPLIT = /\s*>\s*/;

function baseName(s: string): string {
  return normalizeName(s.split(/[\\/]/).pop() ?? s);
}

export interface ExpectedSection {
  file: string | null;
  /** Normalized headings, outermost first; one entry when only a title is known. */
  path: string[];
}

/**
 * The sections a question expects: expected_section_path entries when given (A > B), else
 * expected_section titles. Files pair with sections by position when the counts match; one file
 * applies to every section; otherwise the file is not checked.
 */
export function expectedSections(q: MetricQuestion): ExpectedSection[] {
  const paths = listOf(q.expected_section_path);
  const raw = paths.length ? paths : listOf(q.expected_section);
  const files = listOf(q.expected_source_file);
  return raw.map((p, i) => ({
    file: files.length === raw.length ? baseName(files[i]!) : files.length === 1 ? baseName(files[0]!) : null,
    path: p.split(PATH_SPLIT).map(normalizeName).filter(Boolean),
  }));
}

/** True when the cited section is the expected one: same file if named, and its path ends with the expected path. */
export function sectionMatches(want: ExpectedSection, c: Pick<CitedRecord, 'file' | 'path' | 'title'>): boolean {
  if (want.file && baseName(c.file) !== want.file) return false;
  const have = (c.path.length ? c.path : [c.title]).map(normalizeName);
  if (want.path.length > have.length) return false;
  return want.path.every((h, i) => have[have.length - want.path.length + i] === h);
}

/** Every expected section among the given ones; null when the question expects none or is absent. */
export function targetHit(q: MetricQuestion, sections: Pick<CitedRecord, 'file' | 'path' | 'title'>[]): boolean | null {
  if ((ABSENT as readonly string[]).includes(q.category)) return null;
  const want = expectedSections(q);
  if (!want.length) return null;
  return want.every((w) => sections.some((c) => sectionMatches(w, c)));
}

/** Share of key elements present in the answer; null when the question lists none. */
export function keyCoverage(q: MetricQuestion, answer: string): number | null {
  const elements = listOf(q.key_elements);
  if (!elements.length) return null;
  const hay = squash(answer);
  return elements.filter((e) => hay.includes(squash(e))).length / elements.length;
}

/**
 * True when every cited section contains at least one key element, or when the answer is a
 * refusal to a question whose answer is absent. A refusal to an answerable question, or an answer
 * citing nothing, is false. Null when the question lists no key elements and is not absent.
 */
export function attributionOk(
  q: MetricQuestion,
  o: { refused: boolean; cited: Pick<CitedRecord, 'passage'>[] },
): boolean | null {
  const absent = (ABSENT as readonly string[]).includes(q.category);
  if (o.refused) return absent;
  if (absent) return false;
  const elements = listOf(q.key_elements).map(squash);
  if (!elements.length) return null;
  if (!o.cited.length) return false;
  return o.cited.every((c) => {
    const hay = squash(c.passage);
    return elements.some((e) => hay.includes(e));
  });
}

export interface MetricRow {
  id: string;
  category: string;
  /** Configuration label, so several configurations of one run stay apart. */
  config: string;
  targetHit: boolean | null;
  keyCoverage: number | null;
  attribution: boolean | null;
  firstTokenMs: number | null;
  totalMs: number | null;
}

export interface MetricSummary {
  config: string;
  category: string;
  n: number;
  targetHit: { hit: number; n: number };
  keyCoverage: { mean: number | null; n: number };
  attribution: { hit: number; n: number };
  firstTokenMedianMs: number | null;
  totalMedianMs: number | null;
}

function median(values: number[]): number | null {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** One summary per configuration and category, plus one per configuration over all (category all). */
export function summarizeMetrics(rows: MetricRow[]): MetricSummary[] {
  const out: MetricSummary[] = [];
  for (const config of [...new Set(rows.map((r) => r.config))]) {
    const rs = rows.filter((r) => r.config === config);
    for (const category of ['all', ...new Set(rs.map((r) => r.category))]) {
      const c = category === 'all' ? rs : rs.filter((r) => r.category === category);
      const bools = (k: 'targetHit' | 'attribution') => {
        const known = c.map((r) => r[k]).filter((v): v is boolean => v !== null);
        return { hit: known.filter(Boolean).length, n: known.length };
      };
      const cov = c.map((r) => r.keyCoverage).filter((v): v is number => v !== null);
      out.push({
        config,
        category,
        n: c.length,
        targetHit: bools('targetHit'),
        keyCoverage: { mean: cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : null, n: cov.length },
        attribution: bools('attribution'),
        firstTokenMedianMs: median(c.map((r) => r.firstTokenMs).filter((v): v is number => v !== null)),
        totalMedianMs: median(c.map((r) => r.totalMs).filter((v): v is number => v !== null)),
      });
    }
  }
  return out;
}

const pct = (r: { hit: number; n: number }) => (r.n ? `${Math.round((100 * r.hit) / r.n)}% (${r.hit}/${r.n})` : '-');

export function metricsTable(summaries: MetricSummary[]): string {
  const head =
    '| Config | Category | Questions | Target section hit | Key element coverage | Attribution accuracy | First token median | Total median |';
  const rule = '|---|---|---|---|---|---|---|---|';
  const lines = summaries.map(
    (s) =>
      `| ${s.config} | ${s.category} | ${s.n} | ${pct(s.targetHit)} | ${s.keyCoverage.mean === null ? '-' : `${Math.round(100 * s.keyCoverage.mean)}% (${s.keyCoverage.n})`} | ${pct(s.attribution)} | ${s.firstTokenMedianMs === null ? '-' : `${Math.round(s.firstTokenMedianMs)} ms`} | ${s.totalMedianMs === null ? '-' : `${Math.round(s.totalMedianMs)} ms`} |`,
  );
  return [head, rule, ...lines].join('\n');
}
