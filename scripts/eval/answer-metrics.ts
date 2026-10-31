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
> &
  Partial<Pick<Question, 'question'>>;

/**
 * How key elements are looked for: NFKC, lower case, every dash to -, curly quotes straight, a
 * word broken across a line (con- flicts) joined, the percent sign dropped from the first number
 * of a range (0%-15% is 0-15%), then no whitespace at all.
 */
export function squash(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212\uff0d]/g, '-')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
    .replace(/(\d)\s*%\s*-\s*(\d)/g, '$1-$2')
    .replace(/\s+/g, '');
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
 * Checks the citations against what the answer says. The stated elements are the key elements
 * found in the answer text; attribution is true when the answer states at least one, every cited
 * section contains at least one of the stated ones, and every stated one is in a cited section. So
 * a citation of a section that holds some other key element, but not the fact the answer gives,
 * fails. Stated elements that the question itself contains (paragraph 5.88 in a question about
 * paragraph 5.88) are left out of the check: the answer may repeat the question without the
 * passage repeating it. A refusal (the not-found marker, with or without the sections it checked) to an absent
 * question is true; any other answer to one is false, and so is a refusal to an answerable
 * question or an answer citing nothing. Null when the question lists no key elements and is not
 * absent.
 */
export function attributionOk(
  q: MetricQuestion,
  o: { refused: boolean; answer: string; cited: Pick<CitedRecord, 'passage'>[] },
): boolean | null {
  const absent = (ABSENT as readonly string[]).includes(q.category);
  if (o.refused) return absent;
  if (absent) return false;
  const elements = listOf(q.key_elements).map(squash);
  if (!elements.length) return null;
  if (!o.cited.length) return false;
  const said = squash(o.answer);
  const asked = squash(q.question ?? '');
  const stated = elements.filter((e) => said.includes(e) && !(asked && asked.includes(e)));
  if (!stated.length) return false;
  const passages = o.cited.map((c) => squash(c.passage));
  return (
    passages.every((p) => stated.some((e) => p.includes(e))) && stated.every((e) => passages.some((p) => p.includes(e)))
  );
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
  /** The answer was the not-found state; null when unknown. */
  refused?: boolean | null;
  /** Sentences of the answer with no valid citation (unsupported claims). */
  unsupported?: number | null;
  /** Marked [unsupported: ...] in the question notes (a formula the split does not keep): left out of every summary. */
  excluded?: boolean;
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
  /** Answerable questions returned not-found, over answerable questions. */
  falseRefusals: { hit: number; n: number };
  /** Absent questions given an answer, over absent questions. */
  falseAnswers: { hit: number; n: number };
  unsupportedMean: number | null;
  excluded: number;
}

const isAbsent = (category: string) => (ABSENT as readonly string[]).includes(category);

function share(values: (boolean | null)[]): { hit: number; n: number } {
  const known = values.filter((v): v is boolean => v !== null);
  return { hit: known.filter(Boolean).length, n: known.length };
}

function mean(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
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
    const excludedRows = rows.filter((r) => r.config === config && r.excluded);
    const rs = rows.filter((r) => r.config === config && !r.excluded);
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
        falseRefusals: share(c.filter((r) => !isAbsent(r.category)).map((r) => r.refused ?? null)),
        falseAnswers: share(c.filter((r) => isAbsent(r.category)).map((r) => (r.refused == null ? null : !r.refused))),
        unsupportedMean: mean(c.map((r) => r.unsupported ?? null)),
        excluded: category === 'all' ? excludedRows.length : excludedRows.filter((r) => r.category === category).length,
      });
    }
  }
  return out;
}

const pct = (r: { hit: number; n: number }) => (r.n ? `${Math.round((100 * r.hit) / r.n)}% (${r.hit}/${r.n})` : '-');

export function metricsTable(summaries: MetricSummary[]): string {
  const head =
    '| Config | Category | Questions | Target section hit | Key element coverage | Attribution accuracy | False refusals | False answers | Unsupported sentences per answer | First token median | Total median |';
  const rule = '|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = summaries.map(
    (s) =>
      `| ${s.config} | ${s.category} | ${s.n}${s.excluded ? ` (+${s.excluded} excluded)` : ''} | ${pct(s.targetHit)} | ${s.keyCoverage.mean === null ? '-' : `${Math.round(100 * s.keyCoverage.mean)}% (${s.keyCoverage.n})`} | ${pct(s.attribution)} | ${pct(s.falseRefusals)} | ${pct(s.falseAnswers)} | ${s.unsupportedMean === null ? '-' : s.unsupportedMean.toFixed(2)} | ${s.firstTokenMedianMs === null ? '-' : `${Math.round(s.firstTokenMedianMs)} ms`} | ${s.totalMedianMs === null ? '-' : `${Math.round(s.totalMedianMs)} ms`} |`,
  );
  return [head, rule, ...lines].join('\n');
}
