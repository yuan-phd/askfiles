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
  for (const c of [...sent, ...cited, ...drawn, ...considered]) if (!byN.has(c.n)) byN.set(c.n, c);
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

/** The collapsed title of the other sections: ▸ Show 3 other sections, ▾ Hide 1 other section. */
export function consideredTitle(count, open) {
  const noun = count === 1 ? 'other section' : 'other sections';
  return `${open ? '▾ Hide' : '▸ Show'} ${count} ${noun}`;
}
