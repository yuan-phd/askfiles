/**
 * Citation verification in code (verifyCitations). After a single-mode answer, every sentence is
 * checked against the text of the source it cites: the share of its content words and numbers
 * found in that source's passage after normalization. A sentence below VERIFY_MIN_OVERLAP moves to
 * the selected source with the highest share when that one passes, else it is marked unsupported
 * and loses its citations; a sentence without a citation gets the same treatment. Source cards
 * then show only the sources still cited. No model call is involved.
 *
 * With documentAffinity (docs/plan.md round 7) two rules are added. A question naming exactly one
 * file lets a sentence be attributed only to that file's sources. Among sources with the same
 * section title from different files (Defined Terms, Price Adjustment) the higher overlap wins,
 * also over the source the model cited, and an exact tie cites all of them: never source order.
 */
import type { Claim } from './citations.js';

/**
 * Share of a sentence's content tokens its source must contain. Measured on the round 1 tuning
 * answers (docs/plan.md, qwen3:14b): 41 of 44 cited sentences share 0.5 or more with the source
 * they cite, most above 0.7; the three below are remarks about the sources (they do not mention
 * it, this shows how), between 0.33 and 0.43. A sentence that restates a source passes; one the
 * model wrote from elsewhere does not.
 */
export const VERIFY_MIN_OVERLAP = 0.5;

/** Below this many content tokens the share says nothing; the sentence keeps what it had. */
export const VERIFY_MIN_TOKENS = 2;

const STOPWORDS = new Set(
  (
    'the and for with from into onto upon that this these those which who whom whose what when where why how ' +
    'are was were been being has have had having does did doing can could shall should will would may might must ' +
    'not nor but than then there their them they its his her our your you also any all each every some such only ' +
    'other more most less least very about above below between within without under over after before during per ' +
    'via both either neither whether while because since until unless though although here hereby therein thereof ' +
    'according source sources document documents section sections states stated says said following follows include ' +
    'includes including'
  ).split(' '),
);

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

/** NFKC, lower case, dashes to -, a word broken across a line joined, thousands separators dropped. */
function fold(t: string): string {
  return t
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
    .replace(/(\d),(?=\d{3}\b)/g, '$1');
}

/**
 * Content tokens: words of three or more letters that are not stopwords, every number (decimals
 * kept whole), and character pairs of Chinese, Japanese or Korean runs, which have no spaces.
 */
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of fold(text).matchAll(/\d+(?:\.\d+)*|[\p{L}\p{M}]+/gu)) {
    const w = m[0];
    if (/^\d/.test(w)) out.push(w.replace(/\.$/, ''));
    else if (CJK.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else if (w.length >= 3 && !STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

/** Share of the sentence's distinct content tokens that occur in the source tokens. */
export function overlap(sentence: string[], source: Set<string>): number {
  const distinct = [...new Set(sentence)];
  if (!distinct.length) return 0;
  return distinct.filter((t) => source.has(t)).length / distinct.length;
}

export interface VerifyStats {
  sentences: number;
  /** Sentences whose citation moved to another source. */
  reattributed: number;
  /** Sentences written without a citation that one source supports, now cited to it. */
  attributed: number;
  /** Sentences no selected source supports, after verification. */
  unsupported: number;
}

export interface VerifyOptions {
  minOverlap?: number;
  minTokens?: number;
  /** Source numbers a sentence may be attributed to; all when absent. */
  allowed?: Set<number>;
  /** File and section title per source (meta[n - 1]), for the same-title rule; off when absent. */
  meta?: { file: string; title: string }[];
}

/**
 * Checks each claim against the passages (passages[n - 1] is source n). Returns new claims and
 * the counts; a cited sentence that passes keeps its citations unchanged, unless a same-title
 * source of another file overlaps it more (meta).
 */
export function verifyClaims(
  claims: Claim[],
  passages: string[],
  o: VerifyOptions = {},
): { claims: Claim[]; stats: VerifyStats } {
  const min = o.minOverlap ?? VERIFY_MIN_OVERLAP;
  const minTokens = o.minTokens ?? VERIFY_MIN_TOKENS;
  const sources = passages.map((p) => new Set(contentTokens(p)));
  const eligible = (n: number) => !o.allowed || o.allowed.has(n);
  const titleOf = (n: number) => o.meta?.[n - 1]?.title.trim().toLowerCase() ?? '';
  // Same-title sources of other files, per source.
  const twins = (n: number): number[] => {
    if (!o.meta || !titleOf(n)) return [];
    const out: number[] = [];
    for (let m = 1; m <= sources.length; m++)
      if (m !== n && eligible(m) && titleOf(m) === titleOf(n) && o.meta[m - 1]?.file !== o.meta[n - 1]?.file)
        out.push(m);
    return out;
  };
  const stats: VerifyStats = { sentences: 0, reattributed: 0, attributed: 0, unsupported: 0 };
  const out = claims.map((c): Claim => {
    if (!/[\p{L}\p{N}]{2}/u.test(c.text)) return c;
    stats.sentences++;
    const tokens = contentTokens(c.text);
    if (new Set(tokens).size < minTokens) {
      if (c.unsupported) stats.unsupported++;
      return c;
    }
    const share = (n: number) => overlap(tokens, sources[n - 1] ?? new Set());
    const cited = c.citations.filter(eligible);
    const kept = cited.filter((n) => share(n) >= min);
    if (kept.length) {
      // A same-title source of another file that overlaps more takes the citation's place.
      let moved = false;
      const chosen = kept.map((n) => {
        const better = twins(n).filter((m) => share(m) > share(n));
        if (!better.length) return n;
        moved = true;
        return better.reduce((a, b) => (share(b) > share(a) ? b : a));
      });
      if (moved) stats.reattributed++;
      return { ...c, citations: [...new Set(chosen)], unsupported: false };
    }
    // A sentence that joins facts from the sources it cites passes on their union.
    if (cited.length > 1) {
      const union = new Set(cited.flatMap((n) => [...(sources[n - 1] ?? [])]));
      if (overlap(tokens, union) >= min) return cited.length < c.citations.length ? { ...c, citations: cited } : c;
    }
    let best = 0;
    let bestShare = -1;
    for (let n = 1; n <= sources.length; n++) {
      if (!eligible(n)) continue;
      const v = share(n);
      if (v > bestShare) [best, bestShare] = [n, v];
    }
    if (best && bestShare >= min) {
      if (c.citations.length) stats.reattributed++;
      else stats.attributed++;
      // An exact tie between same-title sections of different files is not broken by order.
      const tied = twins(best).filter((m) => share(m) === bestShare);
      return { ...c, citations: [best, ...tied].sort((a, b) => a - b), unsupported: false };
    }
    stats.unsupported++;
    return { ...c, citations: [], unsupported: true };
  });
  return { claims: out, stats };
}
