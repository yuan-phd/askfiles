import { describe, expect, it } from 'vitest';
import { duplicateGroups, normalizedText, shareDuplicates, textHashOf } from './duplicates.js';
import type { Claim } from './citations.js';

const claim = (citations: number[]): Claim => ({ text: 'x', citations, unsupported: citations.length === 0 });

describe('duplicateTextAttribution (round D4)', () => {
  it('normalizes whitespace, full-width forms and page-number lines, nothing else', () => {
    expect(normalizedText('投标人在 10 日前提出：\n\n  答复。\n- 23 -\n')).toBe('投标人在 10 日前提出: 答复。');
    expect(textHashOf('Ａ  b\nc')).toBe(textHashOf('A b c'));
    // One character apart is a different text: equality by hash only, never by similarity.
    expect(textHashOf('应当在投标截止时间10日前')).not.toBe(textHashOf('应当在投标截止时间15日前'));
  });

  it('groups only sections with equal hashes', () => {
    const g = duplicateGroups(['same text', 'other', 'same  text', '', '  ']);
    expect([...g.entries()]).toEqual([
      [1, [3]],
      [3, [1]],
    ]);
  });

  it('a sentence attributed to one copy is attributed to both; uncited sentences stay as they are', () => {
    const passages = ['clause 2.4 text', 'something else', 'clause 2.4  text'];
    const r = shareDuplicates([claim([1]), claim([2]), claim([]), claim([3, 1])], passages);
    expect(r.claims.map((c) => c.citations)).toEqual([[1, 3], [2], [], [3, 1]]);
    expect(r.claims[2]!.unsupported).toBe(true);
    expect(r.shared).toBe(1);
  });

  it('changes nothing without duplicates', () => {
    const claims = [claim([1])];
    expect(shareDuplicates(claims, ['a', 'b']).claims).toBe(claims);
  });
});
