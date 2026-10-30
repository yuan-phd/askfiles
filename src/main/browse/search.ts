/**
 * Keyword search over section text (plan task 4.5). Chinese has no spaces between words, so a
 * term matches as a plain substring anywhere; no word boundary is assumed in any language. Each
 * whitespace-separated term of the query must occur in the section title or text.
 */

/** Characters of context before the first match in a snippet, and the snippet length. */
const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 220;

/**
 * Folds text for matching: NFKC (full-width forms to ASCII) and lower case, one code point at a
 * time, with map[i] the index in text of the code point that produced folded[i], so a match in
 * the folded text can be found again in the original. map has one extra entry: text.length.
 */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const f = ch.normalize('NFKC').toLowerCase();
    folded += f;
    for (let k = 0; k < f.length; k++) map.push(i);
    i += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

export function fold(text: string): string {
  return foldWithMap(text).folded;
}

/** The query's terms, folded, without repeats; a term inside a longer one is dropped. */
export function queryTerms(query: string): string[] {
  const terms = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
  return terms.filter((t) => !terms.some((o) => o !== t && o.includes(t)));
}

/** Start offsets of every non-overlapping occurrence of term in hay. */
export function occurrences(hay: string, term: string): number[] {
  const out: number[] = [];
  for (let at = hay.indexOf(term); at >= 0; at = hay.indexOf(term, at + term.length)) out.push(at);
  return out;
}

/** [start, end) in text of every occurrence of the terms, overlapping ones merged, in order. */
export function markRanges(text: string, terms: string[]): [number, number][] {
  const { folded, map } = foldWithMap(text);
  const ranges: [number, number][] = [];
  for (const t of terms) for (const at of occurrences(folded, t)) ranges.push([map[at]!, map[at + t.length]!]);
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const [a, b] of ranges) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/**
 * A stretch of text around the first match, with the position of every match inside it. When no
 * term occurs in the text (the title matched), the start of the text.
 */
export function snippetOf(text: string, terms: string[]): { snippet: string; marks: [number, number][] } {
  const ranges = markRanges(text, terms);
  const first = ranges.length ? ranges[0]![0] : 0;
  let start = Math.max(0, first - SNIPPET_BEFORE);
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  // Never cut a surrogate pair in half.
  if (start > 0 && /[\udc00-\udfff]/.test(text[start]!)) start--;
  if (end < text.length && /[\udc00-\udfff]/.test(text[end]!)) end++;
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  const marks = ranges
    .filter(([a, b]) => a >= start && b <= end)
    .map(([a, b]): [number, number] => [a - start + prefix.length, b - start + prefix.length]);
  return { snippet: prefix + text.slice(start, end) + suffix, marks };
}
