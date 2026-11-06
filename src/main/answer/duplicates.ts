/**
 * duplicateTextAttribution (docs/plan.md, round D4): two selected sections whose normalized texts
 * hash the same are one text; a sentence verification attributes to one of them is attributed to
 * both. Equality is by hash only, never by similarity, so no threshold is involved. The case it
 * fixes: two template editions holding a clause word for word (Chinese Q61, 2.4 of both
 * templates) tie in verification and the order of the sources picks one of them, so the other
 * file's identical clause goes uncited.
 */
import { createHash } from 'node:crypto';
import type { Claim } from './citations.js';
import { displayName } from '../browse/identifiers.js';

/**
 * The text a section is compared by (owner's brief, round D4 normalization fix), in this order:
 * NFKC; full-width forms folded to half-width (NFKC does it for letters, digits and punctuation;
 * the explicit fold keeps it so for any form NFKC leaves); all whitespace removed; all ASCII
 * punctuation and all CJK punctuation removed. Letters and digits are never altered: 第五条 and
 * 第5条 stay different texts. CJK punctuation is every character of the CJK Symbols and
 * Punctuation, CJK Compatibility Forms, Vertical Forms, Halfwidth and Fullwidth Forms and General
 * Punctuation blocks and the middle dot that is not a letter or a number (so 〇 and 々 stay).
 */
export function normalizedText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\uff01-\uff5e]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/gu, '')
    .replace(/[!-/:-@[-`{-~]/gu, '')
    .replace(/(?![\p{L}\p{N}])[\u00b7\u2010-\u205e\u3000-\u303f\ufe10-\ufe1f\ufe30-\ufe4f\uff00-\uffef]/gu, '');
}

/** Shorter normalized texts never take part in the identical-text rule (owner's brief). */
export const MIN_IDENTICAL_LENGTH = 50;

export function textHashOf(text: string): string {
  return createHash('sha256').update(normalizedText(text)).digest('hex');
}

/** For each source number (1-based), the other source numbers with the same text hash. */
export function duplicateGroups(passages: string[]): Map<number, number[]> {
  const byHash = new Map<string, number[]>();
  passages.forEach((p, i) => {
    if ([...normalizedText(p)].length < MIN_IDENTICAL_LENGTH) return;
    const h = textHashOf(p);
    byHash.set(h, [...(byHash.get(h) ?? []), i + 1]);
  });
  const out = new Map<number, number[]>();
  for (const ns of byHash.values())
    if (ns.length > 1)
      for (const n of ns)
        out.set(
          n,
          ns.filter((m) => m !== n),
        );
  return out;
}

/**
 * A matcher for one document's names: its display name as a whole phrase (English on word
 * boundaries, any case), and for a Chinese name its title-mark forms 《display name》 and
 * 《name without the year or version after the space》, as file-names.ts namePhrases; for the
 * question also the file name itself.
 */
export function nameMatcher(file: string): { sentence: (t: string) => boolean; question: (t: string) => boolean } {
  const name = displayName(file);
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res: RegExp[] = [];
  if (/[\u3400-\u9fff]/.test(name)) {
    const head = name.split(' ')[0]!;
    for (const t of new Set([name, head])) res.push(new RegExp(`《\\s*${esc(t)}\\s*》`, 'u'));
    res.push(new RegExp(esc(name), 'u'));
  } else {
    const words = name.split(/\s+/).map(esc).join('\\s+');
    res.push(new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'iu'));
  }
  const fileRe = new RegExp(`(?<![\\p{L}\\p{N}_.])${esc(file)}(?![\\p{L}\\p{N}_])`, 'u');
  const sentence = (t: string) => res.some((re) => re.test(t));
  return { sentence, question: (t: string) => sentence(t) || fileRe.test(t) };
}

export interface DuplicateSource {
  passage: string;
  file: string;
}

/** How many citations each tier decided (duplicateTextTiers). */
export interface DuplicateTiers {
  sentence: number;
  question: number;
  all: number;
}

/**
 * Every citation is joined by the sources holding the same text; counts the sentences whose
 * citations changed. With tiers (round D4b), for each cited section and its same-text sections:
 * a. the sentence names exactly one of their documents: only that document's sections;
 * b. else the question (as asked or as sent) names exactly one: only that document's sections;
 * c. else all of them.
 */
export function shareDuplicates(
  claims: Claim[],
  sources: DuplicateSource[],
  tiers?: { question: string[] },
): { claims: Claim[]; shared: number; tiers: DuplicateTiers } {
  const groups = duplicateGroups(sources.map((s) => s.passage));
  const count: DuplicateTiers = { sentence: 0, question: 0, all: 0 };
  if (!groups.size) return { claims, shared: 0, tiers: count };
  const matchers = new Map<string, ReturnType<typeof nameMatcher>>();
  const matcher = (file: string) => {
    if (!matchers.has(file)) matchers.set(file, nameMatcher(file));
    return matchers.get(file)!;
  };
  /** The files of a group named by test, when exactly one file is named. */
  const onlyNamed = (group: number[], test: (file: string) => boolean): string | null => {
    const files = [...new Set(group.map((n) => sources[n - 1]!.file))].filter(test);
    return files.length === 1 ? files[0]! : null;
  };
  let shared = 0;
  const out = claims.map((c) => {
    if (!c.citations.length) return c;
    const all: number[] = [];
    const add = (n: number) => {
      if (!all.includes(n)) all.push(n);
    };
    for (const n of c.citations) {
      const others = groups.get(n);
      if (!others) {
        add(n);
        continue;
      }
      const group = [n, ...others];
      let file: string | null = null;
      if (tiers) {
        file = onlyNamed(group, (f) => matcher(f).sentence(c.text));
        if (file) count.sentence++;
        else {
          file = onlyNamed(group, (f) => tiers.question.some((q) => matcher(f).question(q)));
          if (file) count.question++;
        }
      }
      if (!file) count.all++;
      for (const m of group) if (!file || sources[m - 1]!.file === file) add(m);
    }
    if (all.length === c.citations.length && all.every((n, i) => n === c.citations[i])) return c;
    shared++;
    return { ...c, citations: all };
  });
  return { claims: out, shared, tiers: count };
}
