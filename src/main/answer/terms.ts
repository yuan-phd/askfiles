/**
 * Keyword terms of a question for the keyword half of retrieval. Vector search misses exact terms
 * (a tool name, a code, a phrase such as task teams), so these are the parts of a question that
 * should match literally: quoted phrases, numbers and codes, capitalized multiword names, rare
 * words and rare word pairs, and for Chinese the rare character n-grams of length 2 to 4.
 * Rare means the term occurs in few sections of the index; a term in no section is dropped too,
 * since it cannot match.
 */
import { fold } from '../browse/index.js';

export type TermKind = 'quoted' | 'code' | 'name' | 'pair' | 'word' | 'cjk';

export interface Term {
  /** Folded (NFKC, lower case), as the keyword index matches it. */
  text: string;
  kind: TermKind;
  /** Sections containing the term, from the index. */
  df: number;
}

export interface TermStats {
  /** Sections in the index. */
  total: number;
  /** Sections containing a folded term. */
  frequency(term: string): number;
}

/** A word or pair in more than this share of sections is too common to help. */
export const RARE_SHARE = 0.25;
/** At most this many CJK n-grams per question, the rarest first. */
export const MAX_CJK_TERMS = 12;

// Question words and function words; frequent words are dropped by frequency anyway, but a small
// index has too few sections to tell.
const STOP = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both ' +
    'but by can could did do does doing down during each few for from further had has have having he her here hers ' +
    'him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our ' +
    'out over own same she should so some such than that the their them then there these they this those through to ' +
    'too under until up very was we were what when where which while who whom why will with would you your yours ' +
    'tell show give find list explain describe say says said get got many much per please may might must shall need ' +
    'document documents file files section sections page pages'
  ).split(' '),
);

const CJK_STOP = new Set([
  '什么',
  '怎么',
  '怎样',
  '如何',
  '多少',
  '哪些',
  '哪个',
  '是否',
  '可以',
  '能否',
  '为什么',
  '是什么',
  '有哪些',
  '请问',
  '多久',
  '几天',
  '的是',
  '是多',
  '少天',
  '我们',
  '他们',
  '应该',
  '需要',
  '规定',
  '要求',
]);

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g;

/** Share of letters that are CJK; used to decide whether a text is mainly CJK. */
export function cjkShare(text: string): number {
  const letters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (!letters) return 0;
  return (text.match(new RegExp(CJK.source, 'g'))?.length ?? 0) / letters;
}

export function isMainlyCjk(text: string): boolean {
  return cjkShare(text) >= 0.3;
}

const QUOTED =
  /"([^"]{2,80})"|'([^']{2,80})'|“([^”]{2,80})”|‘([^’]{2,80})’|「([^」]{1,80})」|『([^』]{1,80})』|《([^》]{1,80})》/g;
// Latin-script word, possibly with inner dots, dashes, slashes, underscores or a trailing %.
const WORD = /[\p{L}\p{N}][\p{L}\p{N}._/+#-]*[\p{L}\p{N}%+#]|[\p{L}\p{N}]/gu;

interface Candidate {
  text: string;
  kind: TermKind;
}

function latinWords(question: string): { raw: string; folded: string }[] {
  const out: { raw: string; folded: string }[] = [];
  for (const part of question.split(CJK_RUN)) {
    for (const m of part.matchAll(WORD)) out.push({ raw: m[0], folded: fold(m[0]) });
  }
  return out;
}

function isCode(raw: string): boolean {
  // A number, a token with a digit (ISO-9001, v2, 3.5%), an acronym (HR, VPN), or an identifier
  // with inner punctuation or mixed case (snake_case, camelCase, file.pdf).
  return (
    /\d/.test(raw) ||
    (/^[A-Z]{2,}s?$/.test(raw) && raw.length <= 10) ||
    /[a-z][A-Z]/.test(raw) ||
    /[._/#+]/.test(raw.slice(1, -1))
  );
}

function candidates(question: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of question.matchAll(QUOTED)) {
    const phrase = m
      .slice(1)
      .find((g) => g !== undefined)!
      .trim();
    if (phrase) out.push({ text: fold(phrase), kind: 'quoted' });
  }
  const words = latinWords(question.replace(QUOTED, ' '));
  // Capitalized runs of two or more words, stop words trimmed from the ends (Task Teams, Microsoft Teams).
  let run: string[] = [];
  const flush = () => {
    while (run.length && STOP.has(fold(run[0]!))) run.shift();
    while (run.length && STOP.has(fold(run[run.length - 1]!))) run.pop();
    if (run.length >= 2) out.push({ text: fold(run.join(' ')), kind: 'name' });
    run = [];
  };
  for (const w of words) {
    if (/^\p{Lu}/u.test(w.raw)) run.push(w.raw);
    else flush();
  }
  flush();
  for (const w of words) {
    if (isCode(w.raw)) out.push({ text: w.folded, kind: 'code' });
    else if (w.folded.length >= 3 && !STOP.has(w.folded)) out.push({ text: w.folded, kind: 'word' });
  }
  // Pairs of neighbouring content words, for lower-case phrases such as task teams.
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!.folded;
    const b = words[i + 1]!.folded;
    if (STOP.has(a) || STOP.has(b) || a.length < 2 || b.length < 2) continue;
    out.push({ text: `${a} ${b}`, kind: 'pair' });
  }
  return out;
}

function cjkGrams(question: string): string[] {
  const out: string[] = [];
  for (const m of fold(question).matchAll(CJK_RUN)) {
    const run = m[0];
    for (let n = 4; n >= 2; n--) {
      for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n));
    }
  }
  return [...new Set(out)];
}

/**
 * Terms of a question with their section frequency. Quoted phrases, codes and names are kept
 * whenever they occur in the index; words and pairs only when rare. Of the CJK n-grams, those in
 * no section or in more than RARE_SHARE of them go, then any n-gram inside a longer kept one,
 * then all but the MAX_CJK_TERMS rarest.
 */
export function extractTerms(question: string, stats: TermStats): Term[] {
  const limit = Math.max(1, Math.floor(stats.total * RARE_SHARE));
  const seen = new Map<string, Term>();
  const add = (text: string, kind: TermKind, keep: (df: number) => boolean) => {
    if (!text || seen.has(text)) return;
    const df = stats.frequency(text);
    if (df > 0 && keep(df)) seen.set(text, { text, kind, df });
  };
  for (const c of candidates(question)) {
    add(c.text, c.kind, c.kind === 'word' || c.kind === 'pair' ? (df) => df <= limit : () => true);
  }
  const grams = cjkGrams(question)
    .filter((g) => !CJK_STOP.has(g))
    .map((g) => ({ g, df: stats.frequency(g) }))
    .filter((x) => x.df > 0 && x.df <= limit);
  const kept = grams.filter((x) => !grams.some((o) => o.g !== x.g && o.g.length > x.g.length && o.g.includes(x.g)));
  kept.sort((a, b) => a.df - b.df || b.g.length - a.g.length);
  for (const x of kept.slice(0, MAX_CJK_TERMS)) if (!seen.has(x.g)) seen.set(x.g, { text: x.g, kind: 'cjk', df: x.df });
  return [...seen.values()];
}
