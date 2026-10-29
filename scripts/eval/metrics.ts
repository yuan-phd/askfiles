// Citation checks computed from the sources the server returned. These compare names and
// numbers only; judging the answer text is the owner's job (docs/eval.md).
import { listOf, pagesOf, type Question } from './questions.js';

/** A source as written to results.csv (sources_json). */
export interface SourceRecord {
  file: string;
  sectionTitle: string | null;
  sectionIndex: number | null;
  page: number | null;
  pageEnd: number | null;
  score: number | null;
  passage: string;
}

/** Case, width and spacing do not count; trailing colons and full stops do not either. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:.。：]+$/, '')
    .trim();
}

function baseName(s: string): string {
  return normalizeName(s.split(/[\\/]/).pop() ?? s);
}

/** True when every expected file appears among the sources; null when none is expected. */
export function fileHit(q: Pick<Question, 'expected_source_file'>, sources: SourceRecord[]): boolean | null {
  const want = listOf(q.expected_source_file).map(baseName);
  if (!want.length) return null;
  const have = new Set(sources.map((s) => baseName(s.file)));
  return want.every((w) => have.has(w));
}

/** Share of expected sections that appear among the sources; null when none is expected. */
export function sectionRecall(q: Pick<Question, 'expected_section'>, sources: SourceRecord[]): number | null {
  const want = [...new Set(listOf(q.expected_section).map(normalizeName))];
  if (!want.length) return null;
  const have = new Set(sources.filter((s) => s.sectionTitle).map((s) => normalizeName(s.sectionTitle!)));
  return want.filter((w) => have.has(w)).length / want.length;
}

/** True when every expected section appears among the sources; null when none is expected. */
export function sectionHit(q: Pick<Question, 'expected_section'>, sources: SourceRecord[]): boolean | null {
  const r = sectionRecall(q, sources);
  return r === null ? null : r === 1;
}

/**
 * True when every expected page lies in the page range of a source from an expected file (any
 * file when none is named); null when no page is expected.
 */
export function pageHit(
  q: Pick<Question, 'expected_page' | 'expected_source_file'>,
  sources: SourceRecord[],
): boolean | null {
  const want = pagesOf(q.expected_page);
  if (!want.length) return null;
  const files = new Set(listOf(q.expected_source_file).map(baseName));
  const ranges = sources
    .filter((s) => s.page !== null && s.page > 0 && (!files.size || files.has(baseName(s.file))))
    .map((s) => [s.page!, Math.max(s.page!, s.pageEnd ?? s.page!)] as const);
  return want.every((p) => ranges.some(([a, b]) => p >= a && p <= b));
}

/** One line per source, for reading in a spreadsheet: file, section, pages, score. */
export function describeSources(sources: SourceRecord[]): string {
  return sources
    .map((s, i) => {
      const section = s.sectionTitle ? ` | ${s.sectionIndex ?? '?'} ${s.sectionTitle}` : '';
      const pages = s.page ? ` | p.${s.page}${s.pageEnd && s.pageEnd !== s.page ? `-${s.pageEnd}` : ''}` : '';
      const score = s.score !== null ? ` | ${s.score.toFixed(3)}` : '';
      return `${i + 1}. ${s.file}${section}${pages}${score}`;
    })
    .join('\n');
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
