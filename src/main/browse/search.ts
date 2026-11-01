/**
 * Keyword search over section text (plan task 4.5). Chinese has no spaces between words, so a
 * term matches as a plain substring anywhere; no word boundary is assumed in any language. Each
 * whitespace-separated term of the query must occur in the section title or text; words in
 * quotes ("annual leave", “年假 结转”) form one phrase that must occur as written, any run of
 * whitespace standing for the spaces between its words.
 *
 * Ranking (matchTier): sections where the query's terms occur next to each other and in the
 * query's order first, then sections where they all fall within one paragraph, then the rest.
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

/** Opening and closing quote marks a phrase may be written with. */
const QUOTED = /"([^"]*)"|“([^”]*)”|「([^」]*)」|『([^』]*)』|(\S+)/g;

/**
 * The query's terms, folded, in query order, without repeats; a term inside a longer one is
 * dropped. A quoted phrase is one term, its words joined by single spaces; a term with a space
 * in it is therefore always a phrase.
 */
export function queryTerms(query: string): string[] {
  const parts: string[] = [];
  for (const m of fold(query).matchAll(QUOTED)) {
    const phrase = m[1] ?? m[2] ?? m[3] ?? m[4];
    const t = phrase !== undefined ? phrase.trim().replace(/\s+/g, ' ') : m[5]!.replace(/^["“「『]+|["”」』]+$/g, '');
    if (t) parts.push(t);
  }
  const terms = [...new Set(parts)];
  return terms.filter((t) => !terms.some((o) => o !== t && o.includes(t)));
}

function escapeRe(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The pattern a term matches in folded text: its words with any whitespace between them. */
function termPattern(term: string): string {
  return term.split(' ').map(escapeRe).join('\\s+');
}

/** [start, end) in hay of every non-overlapping match of the term (folded hay and term). */
export function matchesOf(hay: string, term: string): [number, number][] {
  if (!term.includes(' ')) return occurrences(hay, term).map((a) => [a, a + term.length]);
  return [...hay.matchAll(new RegExp(termPattern(term), 'g'))].map((m) => [m.index, m.index + m[0].length]);
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
  for (const t of terms) for (const [a, b] of matchesOf(folded, t)) ranges.push([map[a]!, map[b]!]);
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
 * How a section matches the terms (all of which occur in hay, its folded title and text): 0 when
 * they occur next to each other in the query's order (only whitespace between them), 1 when all
 * fall within one paragraph (the title is one, the text splits at blank lines), else 2.
 */
export function matchTier(hay: string, terms: string[]): 0 | 1 | 2 {
  if (terms.length <= 1) return 0;
  if (new RegExp(terms.map(termPattern).join('\\s*')).test(hay)) return 0;
  // The title is the first line of hay and a paragraph of its own.
  const nl = hay.indexOf('\n');
  const parts = nl >= 0 ? [hay.slice(0, nl), ...hay.slice(nl + 1).split(/\n\s*\n/)] : [hay];
  return parts.some((p) => terms.every((t) => matchesOf(p, t).length > 0)) ? 1 : 2;
}

/**
 * A stretch of text where the terms are densest, with the position of every match inside it: of
 * the windows of SNIPPET_LENGTH characters starting a little before a match, the one holding the
 * most different terms, then the most matches, then the earliest. When no term occurs in the text
 * (the title matched), the start of the text.
 */
export function snippetOf(text: string, terms: string[]): { snippet: string; marks: [number, number][] } {
  const ranges = markRanges(text, terms);
  const { folded, map } = foldWithMap(text);
  const found: { a: number; b: number; term: number }[] = [];
  terms.forEach((t, term) => {
    for (const [a, b] of matchesOf(folded, t)) found.push({ a: map[a]!, b: map[b]!, term });
  });
  let start = 0;
  let best = [-1, -1];
  for (const f of found.sort((x, y) => x.a - y.a)) {
    const ws = Math.max(0, f.a - SNIPPET_BEFORE);
    const inside = found.filter((g) => g.a >= ws && g.b <= ws + SNIPPET_LENGTH);
    const score = [new Set(inside.map((g) => g.term)).size, inside.length];
    if (score[0]! > best[0]! || (score[0] === best[0] && score[1]! > best[1]!)) {
      best = score;
      start = ws;
    }
  }
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
