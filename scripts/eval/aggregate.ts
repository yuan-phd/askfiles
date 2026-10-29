// Aggregates scored result rows. Pure functions: score.ts and compare.ts print what these return.
import { fileHit, median, pageHit, sectionHit, sectionRecall } from './metrics.js';
import { ABSENT, CATEGORIES, type Category } from './questions.js';
import { SCORES, type ResultRow, type Score } from './results.js';

export interface Rate {
  hit: number;
  n: number;
}

export interface CategorySummary {
  category: string;
  rows: number;
  scored: number;
  counts: Record<Score, number>;
  /** Rows the server answered with its refusal (detected from the response, not scored). */
  autoRefused: number;
}

export interface RunSummary {
  categories: CategorySummary[];
  rows: number;
  unscored: number;
  errors: number;
  /** absent_* rows scored refused, over scored absent_* rows. */
  absentRefusal: Rate;
  /** Answerable rows scored refused, over scored answerable rows. */
  falseRefusal: Rate;
  /** Over answerable rows, section_listing aside, that name an expected file, section or page. */
  citation: { file: Rate; section: Rate; page: Rate };
  /** The same, restricted to rows scored correct. */
  citationWhenCorrect: { file: Rate; section: Rate; page: Rate };
  /** Mean share of expected sections listed, over section_listing rows (fallback list on refusal). */
  sectionRecall: { mean: number | null; n: number };
  /** Medians in milliseconds over rows that were answered (not refused, no error). */
  latency: { firstToken: number | null; total: number | null; n: number };
}

const zero = (): Record<Score, number> => Object.fromEntries(SCORES.map((s) => [s, 0])) as Record<Score, number>;

function rate(values: (boolean | null)[]): Rate {
  const known = values.filter((v): v is boolean => v !== null);
  return { hit: known.filter(Boolean).length, n: known.length };
}

function citations(rows: ResultRow[]) {
  return {
    file: rate(rows.map((r) => fileHit(r, r.sources))),
    section: rate(rows.map((r) => sectionHit(r, r.sources))),
    page: rate(rows.map((r) => pageHit(r, r.sources))),
  };
}

export function summarize(rows: ResultRow[]): RunSummary {
  const known = new Set<string>(CATEGORIES);
  const order = [...CATEGORIES, ...[...new Set(rows.map((r) => r.category))].filter((c) => !known.has(c)).sort()];
  const categories = order
    .map((category) => {
      const rs = rows.filter((r) => r.category === category);
      const counts = zero();
      for (const r of rs) if (r.score) counts[r.score]++;
      return {
        category,
        rows: rs.length,
        scored: rs.filter((r) => r.score).length,
        counts,
        autoRefused: rs.filter((r) => r.refused).length,
      };
    })
    .filter((c) => c.rows);
  const isAbsent = (r: ResultRow) => (ABSENT as readonly string[]).includes(r.category);
  const absent = rows.filter((r) => isAbsent(r) && r.score);
  const answerable = rows.filter((r) => !isAbsent(r));
  // Section listing is measured by section recall, which counts the fallback list too.
  const cited = answerable.filter((r) => r.category !== 'section_listing');
  const listing = rows.filter((r) => r.category === 'section_listing');
  const recalls = listing
    .map((r) => sectionRecall(r, r.refused ? r.fallback : r.sources))
    .filter((v): v is number => v !== null);
  const answered = rows.filter((r) => !r.refused && !r.error);
  return {
    categories,
    rows: rows.length,
    unscored: rows.filter((r) => !r.score).length,
    errors: rows.filter((r) => r.error).length,
    absentRefusal: { hit: absent.filter((r) => r.score === 'refused').length, n: absent.length },
    falseRefusal: {
      hit: answerable.filter((r) => r.score === 'refused').length,
      n: answerable.filter((r) => r.score).length,
    },
    citation: citations(cited),
    citationWhenCorrect: citations(cited.filter((r) => r.score === 'correct')),
    sectionRecall: {
      mean: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
      n: recalls.length,
    },
    latency: {
      firstToken: median(answered.map((r) => r.firstTokenMs ?? NaN)),
      total: median(answered.map((r) => r.totalMs ?? NaN)),
      n: answered.length,
    },
  };
}

export function pct(r: Rate): string {
  return r.n ? `${Math.round((100 * r.hit) / r.n)}% (${r.hit}/${r.n})` : '-';
}

/** The headline rate of a category: correct answers, or correct refusals for absent categories. */
export function headline(c: CategorySummary): Rate {
  const absent = (ABSENT as readonly string[]).includes(c.category);
  return { hit: absent ? c.counts.refused : c.counts.correct, n: c.scored };
}

function seconds(ms: number | null): string {
  return ms === null ? '-' : (ms / 1000).toFixed(1);
}

function row(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
}

/** Detailed plain report for one run. */
export function formatReport(title: string, s: RunSummary): string {
  const lines = [title, ''];
  lines.push(row(['Category', 'Rows', 'Scored', ...SCORES, 'Auto-detected refusals', 'Headline']));
  lines.push(row(Array(SCORES.length + 5).fill('---')));
  for (const c of s.categories) {
    lines.push(
      row([
        c.category,
        String(c.rows),
        String(c.scored),
        ...SCORES.map((k) => String(c.counts[k])),
        String(c.autoRefused),
        pct(headline(c)),
      ]),
    );
  }
  lines.push('');
  lines.push(`Refusal correctness on absent questions: ${pct(s.absentRefusal)}`);
  lines.push(`False refusals on answerable questions: ${pct(s.falseRefusal)}`);
  lines.push(
    `Citation hit, answerable rows: file ${pct(s.citation.file)}, section ${pct(s.citation.section)}, page ${pct(s.citation.page)}`,
  );
  lines.push(
    `Citation hit, rows scored correct: file ${pct(s.citationWhenCorrect.file)}, section ${pct(s.citationWhenCorrect.section)}, page ${pct(s.citationWhenCorrect.page)}`,
  );
  lines.push(
    `Section recall on section_listing: ${s.sectionRecall.mean === null ? '-' : `${Math.round(100 * s.sectionRecall.mean)}% (mean of ${s.sectionRecall.n})`}`,
  );
  lines.push(
    `Median latency over ${s.latency.n} answered rows: first token ${seconds(s.latency.firstToken)} s, total ${seconds(s.latency.total)} s`,
  );
  lines.push(`Rows: ${s.rows}, unscored: ${s.unscored}, with errors: ${s.errors}`);
  return lines.join('\n');
}

export const TABLE_CATEGORIES: { key: Category; label: string }[] = [
  { key: 'single_fact', label: 'Single fact' },
  { key: 'middle_of_long_doc', label: 'Long doc' },
  { key: 'cross_document', label: 'Cross doc' },
  { key: 'table_number', label: 'Table' },
  { key: 'version', label: 'Version' },
  { key: 'absent_related', label: 'Absent related (refused)' },
  { key: 'absent_unrelated', label: 'Absent unrelated (refused)' },
];

export interface TableRun {
  corpus: string;
  label: string;
  chatModel: string;
  summary: RunSummary;
}

/** One row per run, ready to paste into docs/plan.md. */
export function markdownTable(runs: TableRun[]): string {
  const header = [
    'Corpus',
    'Config',
    'Chat model',
    ...TABLE_CATEGORIES.map((c) => c.label),
    'Section recall',
    'Citation file / section / page',
    'Median first token / total (s)',
  ];
  const lines = [row(header), row(header.map(() => '---'))];
  for (const r of runs) {
    const s = r.summary;
    const cat = (k: string) => {
      const c = s.categories.find((x) => x.category === k);
      return c ? pct(headline(c)) : '-';
    };
    const ratio = (x: Rate) => (x.n ? `${Math.round((100 * x.hit) / x.n)}%` : '-');
    lines.push(
      row([
        r.corpus,
        r.label,
        r.chatModel,
        ...TABLE_CATEGORIES.map((c) => cat(c.key)),
        s.sectionRecall.mean === null ? '-' : `${Math.round(100 * s.sectionRecall.mean)}%`,
        `${ratio(s.citation.file)} / ${ratio(s.citation.section)} / ${ratio(s.citation.page)}`,
        `${seconds(s.latency.firstToken)} / ${seconds(s.latency.total)}`,
      ]),
    );
  }
  return lines.join('\n');
}

/** Per-category deltas between two runs, in percentage points. */
export function formatComparison(
  a: { title: string; summary: RunSummary },
  b: { title: string; summary: RunSummary },
): string {
  const pp = (x: Rate) => (x.n ? (100 * x.hit) / x.n : null);
  const delta = (x: number | null, y: number | null, unit = ' pp') =>
    x === null || y === null ? '-' : `${y - x >= 0 ? '+' : ''}${(y - x).toFixed(unit === ' pp' ? 0 : 1)}${unit}`;
  const cats = [...new Set([...a.summary.categories, ...b.summary.categories].map((c) => c.category))];
  const find = (s: RunSummary, k: string) => s.categories.find((c) => c.category === k);
  const lines = [`A: ${a.title}`, `B: ${b.title}`, ''];
  lines.push(
    row([
      'Category',
      'A headline',
      'B headline',
      'Delta',
      'A hallucinated',
      'B hallucinated',
      'A auto refusals',
      'B auto refusals',
    ]),
  );
  lines.push(row(Array(8).fill('---')));
  for (const k of cats) {
    const ca = find(a.summary, k);
    const cb = find(b.summary, k);
    const ha = ca ? headline(ca) : { hit: 0, n: 0 };
    const hb = cb ? headline(cb) : { hit: 0, n: 0 };
    const hall = (c?: CategorySummary) => (c ? pct({ hit: c.counts.hallucinated, n: c.scored }) : '-');
    const auto = (c?: CategorySummary) => (c ? pct({ hit: c.autoRefused, n: c.rows }) : '-');
    lines.push(row([k, pct(ha), pct(hb), delta(pp(ha), pp(hb)), hall(ca), hall(cb), auto(ca), auto(cb)]));
  }
  const sa = a.summary;
  const sb = b.summary;
  const line = (name: string, x: Rate, y: Rate) => row([name, pct(x), pct(y), delta(pp(x), pp(y))]);
  lines.push('', row(['Measure', 'A', 'B', 'Delta']), row(['---', '---', '---', '---']));
  lines.push(line('Refusal correctness (absent)', sa.absentRefusal, sb.absentRefusal));
  lines.push(line('False refusals (answerable)', sa.falseRefusal, sb.falseRefusal));
  lines.push(line('Citation file', sa.citation.file, sb.citation.file));
  lines.push(line('Citation section', sa.citation.section, sb.citation.section));
  lines.push(line('Citation page', sa.citation.page, sb.citation.page));
  const rec = (s: RunSummary) => (s.sectionRecall.mean === null ? null : 100 * s.sectionRecall.mean);
  const fmt = (v: number | null, unit: string) => (v === null ? '-' : `${v.toFixed(unit === '%' ? 0 : 1)}${unit}`);
  lines.push(row(['Section recall', fmt(rec(sa), '%'), fmt(rec(sb), '%'), delta(rec(sa), rec(sb))]));
  const sec = (v: number | null) => (v === null ? null : v / 1000);
  lines.push(
    row([
      'Median first token',
      fmt(sec(sa.latency.firstToken), ' s'),
      fmt(sec(sb.latency.firstToken), ' s'),
      delta(sec(sa.latency.firstToken), sec(sb.latency.firstToken), ' s'),
    ]),
  );
  lines.push(
    row([
      'Median total',
      fmt(sec(sa.latency.total), ' s'),
      fmt(sec(sb.latency.total), ' s'),
      delta(sec(sa.latency.total), sec(sb.latency.total), ' s'),
    ]),
  );
  return lines.join('\n');
}
