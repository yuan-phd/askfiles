/**
 * Scored keyword query for the answer pipeline (src/main/answer): BM25 over section text, with each
 * term matched as a folded substring like the browse search (search.ts), so a Chinese term or a
 * multiword phrase needs no word boundary. Unlike browse search, a section matches when it holds
 * any term; rare terms weigh more, through the inverse section frequency.
 */
import { occurrences } from './search.js';

/** BM25 constants; the common defaults, not tuned. */
const K1 = 1.2;
const B = 0.75;

export interface RankedSection {
  documentId: string;
  sectionIndex: number;
  score: number;
  /** The query terms found in this section. */
  terms: string[];
}

/** One section's folded title and text, keyed by document and section. */
export interface FoldedSection {
  documentId: string;
  sectionIndex: number;
  folded: string;
}

/** Number of sections containing term. */
export function sectionFrequency(sections: FoldedSection[], term: string): number {
  let n = 0;
  for (const s of sections) if (s.folded.includes(term)) n++;
  return n;
}

/** Probabilistic idf with the usual +1 inside the log, so a term in every section still counts a little. */
export function idf(total: number, df: number): number {
  return Math.log(1 + (total - df + 0.5) / (df + 0.5));
}

/**
 * The best sections for folded terms, highest BM25 first, ties in document order. Section length
 * is counted in characters, since terms are substrings and Chinese has no words to count.
 */
export function rankSections(sections: FoldedSection[], terms: string[], limit: number): RankedSection[] {
  const unique = [...new Set(terms.filter(Boolean))];
  if (!unique.length || !sections.length || limit <= 0) return [];
  const avg = sections.reduce((a, s) => a + s.folded.length, 0) / sections.length || 1;
  const weights = new Map(unique.map((t) => [t, idf(sections.length, sectionFrequency(sections, t))]));
  const out: RankedSection[] = [];
  for (const s of sections) {
    let score = 0;
    const found: string[] = [];
    for (const t of unique) {
      const tf = occurrences(s.folded, t).length;
      if (!tf) continue;
      found.push(t);
      score += (weights.get(t)! * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * s.folded.length) / avg));
    }
    if (found.length) out.push({ documentId: s.documentId, sectionIndex: s.sectionIndex, score, terms: found });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
