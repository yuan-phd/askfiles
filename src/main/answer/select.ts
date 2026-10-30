/**
 * Picks the sections the model reads: those at or above the rerank floor, at most the scope's
 * section count, within the token budget. Sections stay whole when they fit. When they do not,
 * the longest one is trimmed, and only if that would leave it too short is the lowest-ranked
 * section dropped instead and the fit tried again.
 */
import { estimateTokens } from '../sections/index.js';
import type { AnswerSection } from './sections.js';

/** A trimmed section keeps at least this many tokens, else a section is dropped instead. */
export const MIN_TRIM_TOKENS = 150;

export interface Ranked {
  section: AnswerSection;
  /** Cross-encoder score from 0 to 1; null when reranking was bypassed for this question. */
  rerank: number | null;
}

export type DropReason = 'below-floor' | 'over-count' | 'over-budget';

export interface Selection {
  selected: (Ranked & { trimmed: boolean })[];
  dropped: { key: string; reason: DropReason }[];
  budgetTokens: number;
  usedTokens: number;
}

/** Tokens a section costs in the prompt: its header line and its text. */
export function sectionTokens(s: Pick<AnswerSection, 'path' | 'text'>): number {
  return estimateTokens(`[00] ${s.path.join(' > ')}\n${s.text}\n\n`);
}

function trimTo(s: AnswerSection, tokens: number): AnswerSection {
  let text = s.text;
  // Shrink by the token ratio, then in 10 percent steps, since tokens per character vary.
  let chars = Math.floor((text.length * tokens) / Math.max(1, sectionTokens(s)));
  for (let i = 0; i < 40; i++) {
    text = `${s.text.slice(0, Math.max(0, chars)).trimEnd()}...`;
    if (sectionTokens({ ...s, text }) <= tokens || chars <= 0) break;
    chars = Math.floor(chars * 0.9);
  }
  return { ...s, text };
}

/**
 * ranked must be in rank order, best first. With bypass (no rerank scores) the floor does not
 * apply. Always returns at least one section when any passes the floor, trimmed to the budget.
 */
export function selectSections(
  ranked: Ranked[],
  o: { count: number; floor: number; budgetTokens: number; bypass: boolean },
): Selection {
  const dropped: Selection['dropped'] = [];
  const passing: Ranked[] = [];
  for (const r of ranked) {
    if (!o.bypass && (r.rerank ?? 0) < o.floor) dropped.push({ key: r.section.key, reason: 'below-floor' });
    else if (passing.length >= o.count) dropped.push({ key: r.section.key, reason: 'over-count' });
    else passing.push(r);
  }
  const chosen = passing.map((r) => ({ ...r, trimmed: false }));
  for (;;) {
    const tokens = chosen.map((c) => sectionTokens(c.section));
    const total = tokens.reduce((a, b) => a + b, 0);
    if (total <= o.budgetTokens || !chosen.length) {
      return { selected: chosen, dropped, budgetTokens: o.budgetTokens, usedTokens: total };
    }
    const excess = total - o.budgetTokens;
    let longest = 0;
    tokens.forEach((t, i) => {
      if (t > tokens[longest]!) longest = i;
    });
    const target = tokens[longest]! - excess;
    if (target >= MIN_TRIM_TOKENS || chosen.length === 1) {
      chosen[longest] = {
        ...chosen[longest]!,
        section: trimTo(chosen[longest]!.section, Math.max(1, target)),
        trimmed: true,
      };
      const used = chosen.reduce((a, c) => a + sectionTokens(c.section), 0);
      return { selected: chosen, dropped, budgetTokens: o.budgetTokens, usedTokens: used };
    }
    const last = chosen.pop()!;
    dropped.push({ key: last.section.key, reason: 'over-budget' });
  }
}
