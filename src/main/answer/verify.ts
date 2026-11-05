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
import { sourceSentences } from './source-sentences.js';

/**
 * Share of a sentence's content tokens its source must contain. Measured on the round 1 tuning
 * answers (docs/plan.md, qwen3:14b): 41 of 44 cited sentences share 0.5 or more with the source
 * they cite, most above 0.7; the three below are remarks about the sources (they do not mention
 * it, this shows how), between 0.33 and 0.43. A sentence that restates a source passes; one the
 * model wrote from elsewhere does not.
 */
export const VERIFY_MIN_OVERLAP = 0.5;

/**
 * cjkOverlap: the share a mainly Chinese, Japanese or Korean sentence needs, by character pairs
 * (cjkTokens). Calibrated on the recorded answers of the Chinese set (docs/plan.md, round A1): the
 * highest value at which every citation the model placed on its expected section survives
 * verification. Correct citations share 0.25 to 1.0 of their pairs with the section (paraphrase,
 * and a comparison sentence over several sources), against 0.5 to 1.0 for English words; one
 * fragment with no fact in it (这些信息来源于。) shares none and is left out.
 */
export const VERIFY_MIN_OVERLAP_CJK = 0.3;

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

const CJK_CHAR = '[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]';
const CJK_GAP = new RegExp(`(${CJK_CHAR})\\s+(?=${CJK_CHAR})`, 'gu');
const CJK_RUN = new RegExp(`${CJK_CHAR}+`, 'gu');

/**
 * Tokens of a mainly CJK text for cjkOverlap: character pairs of every CJK run, with the spaces
 * PDF text puts between characters (中 华 人 民) closed up first, so a pair is never lost to a
 * space; every number whole; Latin words as contentTokens takes them. Punctuation and numbers
 * end a run, so a pair never spans a clause boundary.
 */
export function cjkTokens(text: string): string[] {
  const t = fold(text).replace(CJK_GAP, '$1');
  const out: string[] = [];
  for (const m of t.matchAll(/\d+(?:\.\d+)*|[\p{L}\p{M}]+/gu)) {
    const w = m[0];
    if (/^\d/.test(w)) {
      out.push(w.replace(/\.$/, ''));
      continue;
    }
    for (const part of w.split(CJK_RUN)) if (part.length >= 3 && !STOPWORDS.has(part)) out.push(part);
    for (const run of w.match(CJK_RUN) ?? []) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

/** True when at least 30 percent of the letters and digits are CJK (as isMainlyCjk in terms.ts). */
export function mainlyCjk(text: string): boolean {
  const letters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return letters > 0 && (text.match(CJK_RUN)?.join('').length ?? 0) / letters >= 0.3;
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
  /** restatementExempt: uncited sentences that only restate the question, left uncited and not unsupported. */
  restated?: number;
  /** marginReattribution: single-citation sentences moved to a source scoring at least the margin higher. */
  marginMoved?: number;
  /** contentFreeExempt: cited sentences with no content word of their own, their citations not counted. */
  contentFree?: number;
  /** duplicateTextAttribution: sentences that gained the sections holding the same text as one they cite. */
  duplicateShared?: number;
  /** duplicateTextTiers: citations decided by the sentence's name, the question's name, or shared with all. */
  duplicateTiers?: { sentence: number; question: number; all: number };
}

/**
 * contentFreeExempt (round D3): lead-in words a cited sentence may hold besides the question's own
 * words and still say nothing (The sources provide the following:, 具体如下：). Whole phrases,
 * removed before the sentence is tokenized; longer forms first.
 */
export const LEAD_INS = [
  'as follows',
  'the following',
  'following',
  'follows',
  'below',
  'listed',
  'namely',
  'specifically',
  'in summary',
  'summarized',
  'details',
  'detailed',
  '具体规定如下',
  '规定如下',
  '具体如下',
  '分别如下',
  '主要包括',
  '具体包括',
  '如下',
  '包括',
  '以下',
  '下列',
  '具体',
  '分别',
  '主要',
];

/**
 * True when nothing of a sentence is left after its lead-in words and every content token that the
 * question holds are taken out (contentFreeExempt).
 */
export function isContentFree(text: string, question: Set<string>, pairs: boolean): boolean {
  let t = text.normalize('NFKC').toLowerCase();
  for (const lead of LEAD_INS) t = t.split(lead).join(' ');
  const tokens = pairs ? cjkTokens(t) : contentTokens(t);
  return tokens.every((x) => question.has(x));
}

/**
 * restatementExempt (docs/plan.md, round D1): an uncited sentence is a restatement of the question
 * when at least RESTATEMENT_SHARE of its distinct content tokens occur in the question and none is
 * outside it. The second condition implies the first at 1.0; both are kept as the owner wrote them.
 */
export const RESTATEMENT_SHARE = 0.8;

export function isRestatement(tokens: string[], question: Set<string>): boolean {
  const distinct = [...new Set(tokens)];
  if (!distinct.length) return false;
  const inside = distinct.filter((t) => question.has(t)).length;
  return inside / distinct.length >= RESTATEMENT_SHARE && inside === distinct.length;
}

export interface VerifyOptions {
  minOverlap?: number;
  minTokens?: number;
  /** Source numbers a sentence may be attributed to; all when absent. */
  allowed?: Set<number>;
  /** Per claim (by index), in place of allowed: crossDocument's sources of the files a sentence names. */
  allowedFor?: (Set<number> | undefined)[];
  /** File and section title per source (meta[n - 1]), for the same-title rule; off when absent. */
  meta?: { file: string; title: string }[];
  /**
   * cjkOverlap: a mainly CJK sentence is measured by cjkTokens against cjkTokens of the sources,
   * with cjkMinOverlap; other sentences keep contentTokens and minOverlap.
   */
  cjk?: boolean;
  cjkMinOverlap?: number;
  /** restatementExempt: the question texts (as asked and as sent); an uncited restatement of them is exempt. */
  question?: string[];
  /** restatementExempt off while question is given for contentFree only. */
  restatement?: boolean;
  /**
   * marginReattribution: a sentence citing one source that passes moves to another eligible source
   * scoring at least this much higher; off when absent or 0.
   */
  margin?: number;
  /**
   * sentenceMatch: per claim (by index), the score per source (index n - 1) in place of the
   * whole-passage token share; claims without an entry keep the token share.
   */
  scores?: (number[] | undefined)[];
  /**
   * sentenceOverlap (round D3): a source's share is the best share among its sentences (split as
   * the model read the text), not the share of the whole section; the union rule for a sentence
   * citing several sources keeps the whole sections.
   */
  sentenceLevel?: boolean;
  /**
   * contentFreeExempt: a cited sentence with no content word besides the question's (question) and
   * the lead-in words loses its citations without being unsupported: no credit, no failure.
   */
  contentFree?: boolean;
}

/**
 * Checks each claim against the passages (passages[n - 1] is source n). Returns new claims and
 * the counts; a cited sentence that passes keeps its citations unchanged, unless a same-title
 * source of another file overlaps it more (meta) or another source scores the margin higher
 * (margin). Every verified claim carries the score of each citation it keeps (support).
 */
export function verifyClaims(
  claims: Claim[],
  passages: string[],
  o: VerifyOptions = {},
): { claims: Claim[]; stats: VerifyStats } {
  const minTokens = o.minTokens ?? VERIFY_MIN_TOKENS;
  const wordSources = passages.map((p) => new Set(contentTokens(p)));
  let pairSources: Set<string>[] | null = null;
  const pairsOf = () => (pairSources ??= passages.map((p) => new Set(cjkTokens(p))));
  const asked = o.question?.filter(Boolean) ?? [];
  const askedWords = new Set(asked.flatMap((q) => contentTokens(q)));
  const askedPairs = new Set(asked.flatMap((q) => cjkTokens(q)));
  // sentenceOverlap: token sets of each source's sentences, by tokenizer.
  const sentenceSets = new Map<boolean, Set<string>[][]>();
  const sentencesOf = (pairs: boolean) => {
    let v = sentenceSets.get(pairs);
    if (!v) {
      v = passages.map((p) => sourceSentences(p).map((x) => new Set(pairs ? cjkTokens(x) : contentTokens(x))));
      sentenceSets.set(pairs, v);
    }
    return v;
  };
  const titleOf = (n: number) => o.meta?.[n - 1]?.title.trim().toLowerCase() ?? '';
  // Same-title sources of other files, per source.
  const twins = (n: number, eligible: (m: number) => boolean): number[] => {
    if (!o.meta || !titleOf(n)) return [];
    const out: number[] = [];
    for (let m = 1; m <= passages.length; m++)
      if (m !== n && eligible(m) && titleOf(m) === titleOf(n) && o.meta[m - 1]?.file !== o.meta[n - 1]?.file)
        out.push(m);
    return out;
  };
  const stats: VerifyStats = {
    sentences: 0,
    reattributed: 0,
    attributed: 0,
    unsupported: 0,
    ...(asked.length && o.restatement !== false ? { restated: 0 } : {}),
    ...(o.margin ? { marginMoved: 0 } : {}),
    ...(o.contentFree ? { contentFree: 0 } : {}),
  };
  const out = claims.map((c, i): Claim => {
    const allow = o.allowedFor?.[i] ?? o.allowed;
    const eligible = (n: number) => !allow || allow.has(n);
    if (!/[\p{L}\p{N}]{2}/u.test(c.text)) return c;
    stats.sentences++;
    const byPairs = Boolean(o.cjk) && mainlyCjk(c.text);
    const min = byPairs ? (o.cjkMinOverlap ?? VERIFY_MIN_OVERLAP_CJK) : (o.minOverlap ?? VERIFY_MIN_OVERLAP);
    const sources = byPairs ? pairsOf() : wordSources;
    const tokens = byPairs ? cjkTokens(c.text) : contentTokens(c.text);
    if (o.contentFree && c.citations.length && isContentFree(c.text, byPairs ? askedPairs : askedWords, byPairs)) {
      stats.contentFree!++;
      return { ...c, citations: [], unsupported: false, contentFree: true };
    }
    if (new Set(tokens).size < minTokens) {
      if (c.unsupported) stats.unsupported++;
      return c;
    }
    if (
      asked.length &&
      o.restatement !== false &&
      !c.citations.length &&
      isRestatement(tokens, byPairs ? askedPairs : askedWords)
    ) {
      stats.restated!++;
      return { ...c, citations: [], unsupported: false, restatement: true };
    }
    const given = o.scores?.[i];
    const bySentence = o.sentenceLevel ? sentencesOf(byPairs) : null;
    const share = given
      ? (n: number) => given[n - 1] ?? 0
      : bySentence
        ? (n: number) => Math.max(0, ...(bySentence[n - 1] ?? []).map((x) => overlap(tokens, x)))
        : (n: number) => overlap(tokens, sources[n - 1] ?? new Set());
    const done = (citations: number[]): Claim => ({
      ...c,
      citations,
      unsupported: false,
      support: citations.map(share),
      minSupport: min,
    });
    const cited = c.citations.filter(eligible);
    const kept = cited.filter((n) => share(n) >= min);
    if (kept.length) {
      // A same-title source of another file that overlaps more takes the citation's place.
      let moved = false;
      let chosen = kept.map((n) => {
        const better = twins(n, eligible).filter((m) => share(m) > share(n));
        if (!better.length) return n;
        moved = true;
        return better.reduce((a, b) => (share(b) > share(a) ? b : a));
      });
      // marginReattribution: one citation written, another source clearly better.
      if (o.margin && c.citations.length === 1 && chosen.length === 1) {
        const n = chosen[0]!;
        let top = n;
        for (let m = 1; m <= passages.length; m++)
          if (m !== n && eligible(m) && share(m) - share(n) >= o.margin && share(m) > share(top)) top = m;
        if (top !== n) {
          chosen = [top];
          moved = true;
          stats.marginMoved!++;
        }
      }
      if (moved) stats.reattributed++;
      return done([...new Set(chosen)]);
    }
    // A sentence that joins facts from the sources it cites passes on their union.
    if (cited.length > 1) {
      const union = new Set(cited.flatMap((n) => [...(sources[n - 1] ?? [])]));
      if (overlap(tokens, union) >= min) {
        const d = done(cited);
        return cited.length < c.citations.length ? d : { ...c, support: d.support, minSupport: min };
      }
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
      const tied = twins(best, eligible).filter((m) => share(m) === bestShare);
      return done([best, ...tied].sort((a, b) => a - b));
    }
    stats.unsupported++;
    return { ...c, citations: [], unsupported: true };
  });
  return { claims: out, stats };
}
