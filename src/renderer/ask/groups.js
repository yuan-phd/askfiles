// The three groups of source cards under an answer. Every source the model was sent appears in
// exactly one group, once, with its number: cited (in citation order), drawn from (cited by the
// model, citation removed by verification; in source order), and the other sections considered
// (in source order).

/**
 * sent: the numbered sources the model read (the pipeline's sources event); cited, considered and
 * drawn: the answer result's groups. A source in no group, or in two, ends up in exactly one.
 */
export function sourceGroups({ sent = [], cited = [], considered = [], drawn = [] }) {
  const byN = new Map();
  // The result's cards are final; the sources event only fills in a source the result left out.
  for (const c of [...cited, ...drawn, ...considered, ...sent]) if (!byN.has(c.n)) byN.set(c.n, c);
  const used = new Set();
  const take = (list) =>
    list.filter((c) => {
      if (used.has(c.n)) return false;
      used.add(c.n);
      return true;
    });
  const citedOut = take(cited.map((c) => byN.get(c.n)));
  const drawnOut = take([...drawn].sort((a, b) => a.n - b.n).map((c) => byN.get(c.n)));
  const rest = take([...byN.values()].sort((a, b) => a.n - b.n));
  return { cited: citedOut, drawn: drawnOut, considered: rest };
}

/** The words of the other sections' title: Show 3 more sections when closed, Hide 3 sections when open. */
export function consideredTitle(count, open) {
  const noun = count === 1 ? 'section' : 'sections';
  return open ? `Hide ${count} ${noun}` : `Show ${count} more ${noun}`;
}

/**
 * The chevron after the title, as on Compare's Show more. One glyph for both states, turned 180
 * degrees by the class down when closed: ⌄ is not in the system font and came from a fallback
 * font about two thirds the size of ⌃, so a closed chevron looked smaller than an open one.
 */
export const CHEVRON = '⌃';

/** The chevron's class: down (pointing down, the group closed) or up (open). */
export function chevronClass(open) {
  return open ? 'chevron' : 'chevron down';
}
