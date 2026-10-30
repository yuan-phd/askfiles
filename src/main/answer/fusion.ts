/**
 * Reciprocal rank fusion of the vector list and the keyword list, then section scores. Vector hits
 * are sub-chunks and keyword hits are whole sections; each counts once in the fusion by its own
 * key, and a section's score is the sum of the fused scores of everything that maps to it, so a
 * section found by both lists, or by several of its sub-chunks, ranks above one found once.
 */

/** Key of a section across the library: document id and 1-based section index. */
export type SectionKey = string;

export function sectionKey(documentId: string, sectionIndex: number): SectionKey {
  return `${documentId}#${sectionIndex}`;
}

export interface VectorCandidate {
  /** Upstream vector id, or the chunk text when there is none. */
  id: string;
  /** The chunk text without upstream's metadata header. */
  text: string;
  score: number | null;
  /** The section the chunk belongs to; null when it could not be mapped. */
  section: SectionKey | null;
}

export interface KeywordCandidate {
  section: SectionKey;
  score: number;
  terms: string[];
}

export interface FusedSection {
  key: SectionKey;
  score: number;
  /** 1-based ranks in each list; null when absent from it. Best rank among the section's chunks. */
  vectorRank: number | null;
  keywordRank: number | null;
  vectorScore: number | null;
  keywordScore: number | null;
  /** Texts of the vector chunks of this section, best first, to centre a section cut on them. */
  hitTexts: string[];
  terms: string[];
}

export function rrf(rank: number, k: number): number {
  return 1 / (k + rank);
}

/** Sections by fused score, highest first; ties keep the order in which they were first seen. */
export function fuse(vector: VectorCandidate[], keyword: KeywordCandidate[], k: number): FusedSection[] {
  const out = new Map<SectionKey, FusedSection>();
  const get = (key: SectionKey): FusedSection => {
    let s = out.get(key);
    if (!s) {
      s = {
        key,
        score: 0,
        vectorRank: null,
        keywordRank: null,
        vectorScore: null,
        keywordScore: null,
        hitTexts: [],
        terms: [],
      };
      out.set(key, s);
    }
    return s;
  };
  vector.forEach((c, i) => {
    if (!c.section) return;
    const s = get(c.section);
    s.score += rrf(i + 1, k);
    if (s.vectorRank === null) {
      s.vectorRank = i + 1;
      s.vectorScore = c.score;
    }
    if (c.text && !s.hitTexts.includes(c.text)) s.hitTexts.push(c.text);
  });
  keyword.forEach((c, i) => {
    const s = get(c.section);
    s.score += rrf(i + 1, k);
    if (s.keywordRank === null) {
      s.keywordRank = i + 1;
      s.keywordScore = c.score;
      s.terms = c.terms;
    }
  });
  return [...out.values()].sort((a, b) => b.score - a.score);
}
