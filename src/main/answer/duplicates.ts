/**
 * duplicateTextAttribution (docs/plan.md, round D4): two selected sections whose normalized texts
 * hash the same are one text; a sentence verification attributes to one of them is attributed to
 * both. Equality is by hash only, never by similarity, so no threshold is involved. The case it
 * fixes: two template editions holding a clause word for word (Chinese Q61, 2.4 of both
 * templates) tie in verification and the order of the sources picks one of them, so the other
 * file's identical clause goes uncited.
 */
import { createHash } from 'node:crypto';
import { PAGE_NUMBER } from '../sections/cjk.js';
import type { Claim } from './citations.js';

/**
 * The text a section is compared by: page-number lines removed (the index's own pattern; running
 * headers are already gone from section texts), NFKC (full-width letters, digits and punctuation
 * to their half-width forms), whitespace collapsed.
 */
export function normalizedText(text: string): string {
  return text
    .split('\n')
    .filter((l) => !PAGE_NUMBER.test(l.trim()))
    .join('\n')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function textHashOf(text: string): string {
  return createHash('sha256').update(normalizedText(text)).digest('hex');
}

/** For each source number (1-based), the other source numbers with the same text hash. */
export function duplicateGroups(passages: string[]): Map<number, number[]> {
  const byHash = new Map<string, number[]>();
  passages.forEach((p, i) => {
    if (!normalizedText(p)) return;
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

/** Every citation is joined by the sources holding the same text; counts the sentences that gained one. */
export function shareDuplicates(claims: Claim[], passages: string[]): { claims: Claim[]; shared: number } {
  const groups = duplicateGroups(passages);
  if (!groups.size) return { claims, shared: 0 };
  let shared = 0;
  const out = claims.map((c) => {
    if (!c.citations.length) return c;
    const all = [...c.citations];
    for (const n of c.citations) for (const m of groups.get(n) ?? []) if (!all.includes(m)) all.push(m);
    if (all.length === c.citations.length) return c;
    shared++;
    return { ...c, citations: all };
  });
  return { claims: out, shared };
}
