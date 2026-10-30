/**
 * Reciprocal rank fusion of the vector list and the keyword list, then section scores. Vector hits
 * are sub-chunks and keyword hits are whole sections. A section scores the RRF of its best
 * sub-chunk plus the RRF of its keyword rank, so one found by both lists ranks above one found by
 * one. Further sub-chunks of the same section add only a tie-breaker, at most MULTI_HIT_SHARE of
 * that score: summing them let long sections with several mediocre sub-chunks outrank the section
 * both lists put first (the owner's first eval, 2026-10-30).
 */

/** Most that a section's further vector hits add, as a share of its own score. */
export const MULTI_HIT_SHARE = 0.1;

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
  /** RRF of the further sub-chunks, before the MULTI_HIT_SHARE cap; 0 with one hit. */
  extraVector: number;
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
        extraVector: 0,
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
    if (s.vectorRank === null) {
      s.vectorRank = i + 1;
      s.vectorScore = c.score;
      s.score += rrf(i + 1, k);
    } else {
      s.extraVector += rrf(i + 1, k);
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
  for (const s of out.values()) s.score += Math.min(MULTI_HIT_SHARE * s.score, s.extraVector);
  return [...out.values()].sort((a, b) => b.score - a.score);
}
