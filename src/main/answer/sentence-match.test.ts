import { describe, expect, it } from 'vitest';
import { claimsOf, parseCitations } from './citations.js';
import { SentenceVectorCache, sentenceScores, sourceSentences } from './sentence-match.js';
import { isRestatement, contentTokens, verifyClaims } from './verify.js';

describe('sourceSentences', () => {
  it('splits English at .!? but not after abbreviations, initials, list markers or inside numbers', () => {
    const text =
      'Under para. 5.88 the Borrower awards the contract. See e.g. Annex 1! Is it final?\n\ng. developing a framework; and\n1. Prepare the plan.';
    expect(sourceSentences(text)).toEqual([
      'Under para. 5.88 the Borrower awards the contract.',
      'See e.g. Annex 1!',
      'Is it final?',
      'g. developing a framework; and 1. Prepare the plan.',
    ]);
  });

  it('splits Chinese at 。！？； and joins lines wrapped inside a sentence', () => {
    const text = '违法行为记录公告期限为六个月。公告期满后，转\n\n入后台保存；依法限制的，从其决定！';
    expect(sourceSentences(text)).toEqual([
      '违法行为记录公告期限为六个月。',
      '公告期满后，转入后台保存；',
      '依法限制的，从其决定！',
    ]);
  });
});

describe('sentenceScores', () => {
  // A fake embedder: a vector per text from a fixed table, so the cosine is known.
  const table: Record<string, number[]> = {
    'Leave is 27 days.': [1, 0],
    'Parking is free.': [0, 1],
    'Staff get 27 days of leave.': [0.9, 0.1],
  };
  const calls: string[][] = [];
  const deps = {
    embed: async (texts: string[]) => {
      calls.push(texts);
      return texts.map((t) => table[t] ?? [0.5, 0.5]);
    },
    model: 'm',
    cache: new SentenceVectorCache(),
  };

  it('takes the larger of sentence overlap and cosine, a section scoring its best sentence, and embeds a section once', async () => {
    const passages = ['Leave is 27 days. Parking is free.', 'Parking is free.'];
    const a = await sentenceScores(['Staff get 27 days of leave.'], passages, { cjk: false, deps });
    const [s1, s2] = a.scores[0]!;
    // Against "Leave is 27 days.": token overlap 3 of 5 (staff, get, 27, days, leave), cosine 0.99.
    expect(s1).toBeGreaterThan(0.9);
    expect(s2).toBeLessThan(0.2);
    expect(a.sectionsEmbedded).toBe(2);
    const b = await sentenceScores(['Staff get 27 days of leave.'], passages, { cjk: false, deps });
    expect(b.sectionsEmbedded).toBe(0);
    expect(calls[1]).toEqual(['Staff get 27 days of leave.']);
    expect(b.scores[0]).toEqual(a.scores[0]);
  });
});

describe('verification rules of rounds D1 and D2', () => {
  const passages = ['Employees get 27 days of paid leave each year.', 'Parking at the office is free for staff.'];

  it('exempts an uncited sentence that only restates the question, and verifies one that adds a fact', () => {
    const question = 'How many days of paid leave do employees get?';
    const claims = claimsOf(
      parseCitations('Employees get paid leave days. Employees get 27 days of paid leave [1].'),
      2,
    );
    const v = verifyClaims(claims, passages, { question: [question] });
    expect(v.claims[0]).toMatchObject({ citations: [], unsupported: false, restatement: true });
    expect(v.claims[1]).toMatchObject({ citations: [1], unsupported: false });
    expect(v.stats.restated).toBe(1);
    // A new fact (27) is not in the question: verified as before, here attributed to [1].
    const added = claimsOf(parseCitations('Employees get 27 days of paid leave.'), 2);
    expect(verifyClaims(added, passages, { question: [question] }).claims[0]).toMatchObject({ citations: [1] });
    expect(isRestatement(contentTokens('paid leave'), new Set(contentTokens(question)))).toBe(true);
    expect(isRestatement(contentTokens('paid leave 27'), new Set(contentTokens(question)))).toBe(false);
  });

  it('records the score of each kept citation and its threshold', () => {
    const v = verifyClaims(claimsOf(parseCitations('Employees get 27 days of paid leave [1].'), 2), passages);
    expect(v.claims[0]!.support).toEqual([1]);
    expect(v.claims[0]!.minSupport).toBe(0.5);
  });

  it('uses given scores in place of the token share and moves a single citation by the margin', () => {
    const claims = claimsOf(parseCitations('Staff park for free [1]. Staff get leave [1][2].'), 2);
    const scores = [
      [0.6, 0.9],
      [0.6, 0.9],
    ];
    const kept = verifyClaims(claims, passages, { scores, minOverlap: 0.56 });
    expect(kept.claims.map((c) => c.citations)).toEqual([[1], [1, 2]]);
    const moved = verifyClaims(claims, passages, { scores, minOverlap: 0.56, margin: 0.25 });
    // Only the single-citation sentence moves; 0.9 - 0.6 is at least 0.25.
    expect(moved.claims.map((c) => c.citations)).toEqual([[2], [1, 2]]);
    expect(moved.stats.marginMoved).toBe(1);
    expect(verifyClaims(claims, passages, { scores, minOverlap: 0.56, margin: 0.35 }).stats.marginMoved).toBe(0);
  });
});
