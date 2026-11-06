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
  /**
   * Other sections that count as this one, written after | in the key: of the same file
   * (4.2 交货前检验 | 4.1 监造, a key whose facts two sections hold alike; docs/plan.md, Q12), or of
   * another file written file :: path (Chinese Q17: the values are only in the xlsx extract).
   */
  alternatives?: { file: string | null; path: string[] }[];
}

/**
 * The sections a question expects: expected_section_path entries when given (A > B), else
 * expected_section titles. Files pair with sections by position when the counts match; one file
 * applies to every section; otherwise the file is not checked. An entry A | B accepts either, and
 * A | file :: B accepts B of another file.
 */
export function expectedSections(q: MetricQuestion): ExpectedSection[] {
  const paths = listOf(q.expected_section_path);
  const raw = paths.length ? paths : listOf(q.expected_section);
  const files = listOf(q.expected_source_file);
  const pathOf = (x: string) => x.split(PATH_SPLIT).map(normalizeName).filter(Boolean);
  return raw.map((p, i) => {
    const [first, ...rest] = p
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean);
    const file = files.length === raw.length ? baseName(files[i]!) : files.length === 1 ? baseName(files[0]!) : null;
    const alternative = (x: string) => {
      const m = /^(.+?)\s*::\s*(.+)$/.exec(x);
      return m ? { file: baseName(m[1]!), path: pathOf(m[2]!) } : { file, path: pathOf(x) };
    };
    return { file, path: pathOf(first ?? ''), ...(rest.length ? { alternatives: rest.map(alternative) } : {}) };
  });
}

/** True when the cited section is the expected one: same file if named, and its path ends with the expected path. */
export function sectionMatches(want: ExpectedSection, c: Pick<CitedRecord, 'file' | 'path' | 'title'>): boolean {
  const have = (c.path.length ? c.path : [c.title]).map(normalizeName);
  const at = (file: string | null, path: string[]) =>
    (!file || baseName(c.file) === file) &&
    path.length <= have.length &&
    path.every((h, i) => have[have.length - path.length + i] === h);
  return at(want.file, want.path) || (want.alternatives ?? []).some((a) => at(a.file, a.path));
}

/** A file name without its number prefix and extension: 04_必须招标的工程项目规定.pdf and 13_必须招标的工程项目规定.docx are one document. */
export function documentName(file: string): string {
  return baseName(file)
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+[_\s-]+/, '');
}

/**
 * Duplicate documents share credit (docs/plan.md, round A3b): a cited section of another file
 * with the same document name as the expected file (the Word copy of a regulation) counts as the
 * expected section when its text holds every key element of the question.
 */
function duplicateHolds(
  q: MetricQuestion,
  want: ExpectedSection,
  c: Partial<Pick<CitedRecord, 'passage'>> & Pick<CitedRecord, 'file'>,
): boolean {
  if (!want.file || c.passage === undefined || baseName(c.file) === want.file) return false;
  if (documentName(c.file) !== documentName(want.file)) return false;
  const elements = listOf(q.key_elements).map(squash);
  const text = squash(c.passage);
  return elements.length > 0 && elements.every((e) => text.includes(e));
}

/** Every expected section among the given ones; null when the question expects none or is absent. */
export function targetHit(
  q: MetricQuestion,
  sections: (Pick<CitedRecord, 'file' | 'path' | 'title'> & Partial<Pick<CitedRecord, 'passage'>>)[],
): boolean | null {
  if ((ABSENT as readonly string[]).includes(q.category)) return null;
  const want = expectedSections(q);
  if (!want.length) return null;
  return want.every((w) => sections.some((c) => sectionMatches(w, c) || duplicateHolds(q, w, c)));
}

/**
 * The key elements that appear word for word (after squash) in the expected sections' text, and
 * the rest. Coverage counts only the first: an element the owner wrote as a paraphrase cannot be
 * found in any answer that quotes the document (docs/plan.md, Acceptance and stopping rules).
 */
export function literalElements(q: MetricQuestion, expectedText: string): { literal: string[]; missing: string[] } {
  const hay = squash(expectedText);
  const all = listOf(q.key_elements);
  return { literal: all.filter((e) => hay.includes(squash(e))), missing: all.filter((e) => !hay.includes(squash(e))) };
}

/**
 * Share of key elements present in the answer; null when the question lists none. With only, the
 * share of those (the literal elements); null when that list is empty.
 */
export function keyCoverage(q: MetricQuestion, answer: string, only?: string[]): number | null {
  const elements = only ?? listOf(q.key_elements);
  if (!elements.length) return null;
  const hay = squash(answer);
  return elements.filter((e) => hay.includes(squash(e))).length / elements.length;
}

/** A sentence of the answer with its citations and, after verification, each citation's score. */
export interface ScoredClaim {
  citations: number[];
  support?: number[];
  minSupport?: number;
}

export interface Attribution {
  /** Attribution as defined from round D1 on (attributionOk). */
  ok: boolean | null;
  /** The definition before round D1 (attributionStrict). */
  strict: boolean | null;
  /** Cited sections that hold none of the stated key elements: the old requirement, now a side count. */
  citedWithoutKey: number;
  /** Citations whose sentence scores below the threshold against the section it cites. */
  weakCitations: number;
}

/**
 * Checks the citations against what the answer says. The stated elements are the key elements
 * found in the answer text, less those the question itself contains (paragraph 5.88 in a question
 * about paragraph 5.88: the answer may repeat the question without the passage repeating it).
 * From round D1 on (docs/plan.md) attribution is true when the answer states at least one, every
 * stated one is in some cited section, and every cited section supports the sentence that cites
 * it: the sentence passed the verification threshold against it (claims with support; a sentence
 * verification did not score, too short or verification off, is not held to it). The old
 * requirement that every cited section hold a stated element is strict, kept beside it with the
 * count of cited sections that hold none. A refusal (the not-found marker, with or without the
 * sections it checked) to an absent question is true; any other answer to one is false, and so is
 * a refusal to an answerable question or an answer citing nothing. Null when the question lists
 * no key elements and is not absent.
 */
export function attribution(
  q: MetricQuestion,
  o: { refused: boolean; answer: string; cited: Pick<CitedRecord, 'passage'>[]; claims?: ScoredClaim[] },
): Attribution {
  const absent = (ABSENT as readonly string[]).includes(q.category);
  const plain = (v: boolean | null): Attribution => ({ ok: v, strict: v, citedWithoutKey: 0, weakCitations: 0 });
  if (o.refused) return plain(absent);
  if (absent) return plain(false);
  const elements = listOf(q.key_elements).map(squash);
  if (!elements.length) return plain(null);
  if (!o.cited.length) return plain(false);
  const said = squash(o.answer);
  const asked = squash(q.question ?? '');
  const stated = elements.filter((e) => said.includes(e) && !(asked && asked.includes(e)));
  const passages = o.cited.map((c) => squash(c.passage));
  const citedWithoutKey = passages.filter((p) => !stated.some((e) => p.includes(e))).length;
  let weakCitations = 0;
  for (const c of o.claims ?? []) {
    if (!c.support || c.minSupport === undefined) continue;
    weakCitations += c.support.filter((v) => v < c.minSupport!).length;
  }
  if (!stated.length) return { ok: false, strict: false, citedWithoutKey, weakCitations };
  const found = stated.every((e) => passages.some((p) => p.includes(e)));
  return {
    ok: found && weakCitations === 0,
    strict: found && citedWithoutKey === 0,
    citedWithoutKey,
    weakCitations,
  };
}

/** Attribution as defined from round D1 on; see attribution. */
export function attributionOk(
  q: MetricQuestion,
  o: { refused: boolean; answer: string; cited: Pick<CitedRecord, 'passage'>[]; claims?: ScoredClaim[] },
): boolean | null {
  return attribution(q, o).ok;
}

/** Attribution as defined before round D1: also every cited section holds a stated key element. */
export function attributionStrict(
  q: MetricQuestion,
  o: { refused: boolean; answer: string; cited: Pick<CitedRecord, 'passage'>[] },
): boolean | null {
  return attribution(q, o).strict;
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
