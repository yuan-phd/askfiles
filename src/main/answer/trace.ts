/** What the developer panel shows for the last question: every stage's list with its scores. */
import type { Retrieval } from './pipeline.js';
import type { Selection } from './select.js';

export interface Trace {
  question: string;
  scope: string;
  terms: { text: string; kind: string; df: number }[];
  vector: { rank: number; file: string | null; section: string | null; score: number | null; preview: string }[];
  keyword: { rank: number; section: string; score: number; terms: string[] }[];
  fused: { key: string; score: number; vectorRank: number | null; keywordRank: number | null }[];
  candidates: {
    key: string;
    file: string;
    sectionIndex: number;
    path: string[];
    rerank: number | null;
    selected: boolean;
    dropped: string | null;
    pageStart: number | null;
  }[];
  bypassReason: string | null;
  floor: number;
  count: number;
  budgetTokens: number;
  usedTokens: number;
  timings: Record<string, number | null>;
}

export function buildTrace(r: Retrieval, sel: Selection, o: { scope: string; floor: number; count: number }): Trace {
  const selected = new Set(sel.selected.map((x) => x.section.key));
  const dropped = new Map(sel.dropped.map((d) => [d.key, d.reason]));
  return {
    question: r.question,
    scope: o.scope,
    terms: r.terms.map((t) => ({ text: t.text, kind: t.kind, df: t.df })),
    vector: r.vector.map((v, i) => ({
      rank: i + 1,
      file: v.file,
      section: v.section,
      score: v.score,
      preview: v.text.replace(/\s+/g, ' ').slice(0, 140),
    })),
    keyword: r.keyword.map((k, i) => ({ rank: i + 1, section: k.section, score: k.score, terms: k.terms })),
    fused: r.fused.map((f) => ({ key: f.key, score: f.score, vectorRank: f.vectorRank, keywordRank: f.keywordRank })),
    candidates: r.candidates.map((c, i) => ({
      key: c.key,
      file: c.file,
      sectionIndex: c.sectionIndex,
      path: c.path,
      rerank: r.rerank[i] ?? null,
      selected: selected.has(c.key),
      dropped: dropped.get(c.key) ?? null,
      pageStart: c.pageStart,
    })),
    bypassReason: r.bypassReason,
    floor: o.floor,
    count: o.count,
    budgetTokens: sel.budgetTokens,
    usedTokens: sel.usedTokens,
    timings: { ...r.timings },
  };
}
