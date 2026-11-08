/**
 * English stemming for the keyword path (answer switch keywordStemming, docs/eval.md): the Porter
 * algorithm (M.F. Porter, An algorithm for suffix stripping, 1980), with the two departures of
 * Porter's own reference implementation (bli to ble, logi to log). Only runs of ASCII letters are
 * stemmed; Chinese, other scripts, digits and punctuation pass through unchanged.
 */

const VOWEL = /[aeiou]/;

/** True when word[i] is a consonant: not a vowel, and y only after a vowel or at the start. */
function consonant(w: string, i: number): boolean {
  const c = w[i]!;
  if (VOWEL.test(c)) return false;
  if (c === 'y') return i === 0 || !consonant(w, i - 1);
  return true;
}

/** m in [C](VC)^m[V]: the number of vowel-consonant sequences. */
function measure(stem: string): number {
  let m = 0;
  let i = 0;
  const n = stem.length;
  while (i < n && consonant(stem, i)) i++;
  while (i < n) {
    while (i < n && !consonant(stem, i)) i++;
    if (i >= n) break;
    while (i < n && consonant(stem, i)) i++;
    m++;
  }
  return m;
}

function hasVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) if (!consonant(stem, i)) return true;
  return false;
}

function doubleConsonant(w: string): boolean {
  const n = w.length;
  return n >= 2 && w[n - 1] === w[n - 2] && consonant(w, n - 1);
}

/** *o: ends consonant, vowel, consonant, the last not w, x or y. */
function cvc(w: string): boolean {
  const n = w.length;
  if (n < 3 || !consonant(w, n - 1) || consonant(w, n - 2) || !consonant(w, n - 3)) return false;
  return !'wxy'.includes(w[n - 1]!);
}

type Rule = [suffix: string, replacement: string];

/** The first rule whose suffix ends w, longest suffix first; applied only when the stem's m is above min. */
function replaceSuffix(w: string, rules: Rule[], min: number): string {
  for (const [suffix, rep] of rules) {
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    return measure(stem) > min ? stem + rep : w;
  }
  return w;
}

const byLength = (rules: Rule[]) => [...rules].sort((a, b) => b[0].length - a[0].length);

const STEP2 = byLength([
  ['ational', 'ate'],
  ['tional', 'tion'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['bli', 'ble'],
  ['alli', 'al'],
  ['entli', 'ent'],
  ['eli', 'e'],
  ['ousli', 'ous'],
  ['ization', 'ize'],
  ['ation', 'ate'],
  ['ator', 'ate'],
  ['alism', 'al'],
  ['iveness', 'ive'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['biliti', 'ble'],
  ['logi', 'log'],
]);

const STEP3 = byLength([
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ful', ''],
  ['ness', ''],
]);

const STEP4 = byLength(
  [
    'al',
    'ance',
    'ence',
    'er',
    'ic',
    'able',
    'ible',
    'ant',
    'ement',
    'ment',
    'ent',
    'ion',
    'ou',
    'ism',
    'ate',
    'iti',
    'ous',
    'ive',
    'ize',
  ].map((s): Rule => [s, '']),
);

/** The Porter stem of one lower-case English word. Words of one or two letters stay as they are. */
export function porterStem(word: string): string {
  let w = word;
  if (w.length <= 2) return w;

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b
  let again = false;
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith('ed') && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    again = true;
  } else if (w.endsWith('ing') && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    again = true;
  }
  if (again) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
    else if (doubleConsonant(w) && !'lsz'.includes(w[w.length - 1]!)) w = w.slice(0, -1);
    else if (measure(w) === 1 && cvc(w)) w += 'e';
  }

  // Step 1c
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;

  w = replaceSuffix(w, STEP2, 0);
  w = replaceSuffix(w, STEP3, 0);

  // Step 4; ion only after s or t.
  for (const [suffix] of STEP4) {
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    if (measure(stem) > 1 && (suffix !== 'ion' || /[st]$/.test(stem))) w = stem;
    break;
  }

  // Step 5a
  if (w.endsWith('e')) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !cvc(stem))) w = stem;
  }
  // Step 5b
  if (measure(w) > 1 && doubleConsonant(w) && w.endsWith('l')) w = w.slice(0, -1);
  return w;
}

/** Around each stemmed word, so a stemmed term matches whole words only (plan is not in planet). */
export const WORD_MARK = '\u0001';

const cache = new Map<string, string>();

/**
 * A folded text (browse fold: NFKC, lower case) with every run of ASCII letters replaced by its
 * marked Porter stem; everything else as it was. The index and the question terms both go through
 * this, so leave planning and Leave Plan meet at leav plan.
 */
export function stemFolded(folded: string): string {
  return folded.replace(/[a-z]+/g, (w) => {
    let s = cache.get(w);
    if (s === undefined) {
      s = `${WORD_MARK}${porterStem(w)}${WORD_MARK}`;
      if (cache.size < 200_000) cache.set(w, s);
    }
    return s;
  });
}
