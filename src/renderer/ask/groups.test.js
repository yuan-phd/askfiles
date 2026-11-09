import { describe, expect, it } from 'vitest';
import { consideredTitle, sourceGroups } from './groups.js';

const card = (n) => ({ n, file: `garden-${n}.md`, title: `Section ${n}`, passage: `Text ${n}.` });
const numbers = (g) => ({
  cited: g.cited.map((c) => c.n),
  drawn: g.drawn.map((c) => c.n),
  considered: g.considered.map((c) => c.n),
});
const everyOnce = (g, sent) => {
  const all = [...g.cited, ...g.drawn, ...g.considered].map((c) => c.n);
  expect([...all].sort((a, b) => a - b)).toEqual(sent.map((c) => c.n));
};

describe('sourceGroups', () => {
  const sent = [1, 2, 3, 4, 5].map(card);

  it('puts every source sent in exactly one group, once', () => {
    // As the pipeline sends them: drawn sources are in considered too.
    const g = sourceGroups({
      sent,
      cited: [card(3), card(1)],
      considered: [card(2), card(4), card(5)],
      drawn: [card(4)],
    });
    expect(numbers(g)).toEqual({ cited: [3, 1], drawn: [4], considered: [2, 5] });
    everyOnce(g, sent);
  });

  it('shows a source no group holds under the other sections, so no number is lost', () => {
    const g = sourceGroups({ sent, cited: [card(1)], considered: [card(2)], drawn: [] });
    expect(numbers(g)).toEqual({ cited: [1], drawn: [], considered: [2, 3, 4, 5] });
    everyOnce(g, sent);
  });

  it('shows a source cited twice or in two groups once, in the first group that has it', () => {
    const g = sourceGroups({
      sent,
      cited: [card(2), card(2)],
      considered: [card(2), card(1), card(3), card(4), card(5)],
      drawn: [card(2), card(5)],
    });
    expect(numbers(g)).toEqual({ cited: [2], drawn: [5], considered: [1, 3, 4] });
    everyOnce(g, sent);
  });

  it("takes a card's details from the result, the sources event only for a source the result left out", () => {
    const g = sourceGroups({ sent: [card(1), card(2)], cited: [{ ...card(1), trimmed: true }], considered: [] });
    expect(g.cited[0].trimmed).toBe(true);
    expect(g.considered.map((c) => c.n)).toEqual([2]);
  });

  it('works without the sources event, from the result alone', () => {
    const g = sourceGroups({ cited: [card(2)], considered: [card(1), card(3)], drawn: [card(3)] });
    expect(numbers(g)).toEqual({ cited: [2], drawn: [3], considered: [1] });
  });
});

describe('consideredTitle', () => {
  it('says what opening or closing does, with the count', () => {
    expect(consideredTitle(3, false)).toBe('▸ Show 3 more sections');
    expect(consideredTitle(3, true)).toBe('▾ Hide 3 sections');
    expect(consideredTitle(1, false)).toBe('▸ Show 1 more section');
    expect(consideredTitle(1, true)).toBe('▾ Hide 1 section');
  });
});
