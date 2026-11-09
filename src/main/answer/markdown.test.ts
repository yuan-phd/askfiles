import { describe, expect, it } from 'vitest';
import { claimsOf, parseCitations } from './citations.js';
import { claimsText } from './hedges.js';
import { plainText } from './markdown.js';
import { verifyClaims, type VerifyOptions } from './verify.js';

const claims = (answer: string, max = 3) => claimsOf(parseCitations(answer), max);

// Invented sources and answers: one written with Markdown, the same without it.
const passages = [
  'Tomatoes need full sun and water twice a week in summer.',
  'Basil grows best in warm soil and should be pinched back often.',
  'Mint spreads quickly and is best kept in a pot.',
];

describe('plainText (main process)', () => {
  it('removes list markers, emphasis and code backticks, nothing else', () => {
    expect(plainText('1. **Tomatoes**: full sun.\n  - `pot`').plain).toBe('Tomatoes: full sun.\npot');
    expect(plainText('Plain text, 2 * 3 and file_name.txt.').plain).toBe('Plain text, 2 * 3 and file_name.txt.');
  });
});

describe('claimsOf on Markdown', () => {
  it('splits sentences as the text without Markdown, and keeps the Markdown for display', () => {
    const md = claims('Three plants:\n1. **Tomatoes** need full sun [1].\n2. *Basil* grows in warm soil [2].\n');
    const bare = claims('Three plants:\nTomatoes need full sun [1].\nBasil grows in warm soil [2].\n');
    expect(md.map((c) => c.text)).toEqual(bare.map((c) => c.text));
    expect(md.map((c) => c.citations)).toEqual(bare.map((c) => c.citations));
    expect(md.map((c) => c.markdown)).toEqual([
      undefined,
      '1. **Tomatoes** need full sun .\n',
      '2. *Basil* grows in warm soil .\n',
    ]);
  });

  it('never makes a list number a sentence of its own', () => {
    const items = Array.from({ length: 12 }, (_, i) => `${i + 1}. Mint spreads quickly [3].`).join('\n');
    const c = claims(items);
    expect(c).toHaveLength(12);
    expect(c.every((x) => !x.unsupported && x.citations[0] === 3)).toBe(true);
  });

  it('ends a sentence at a full stop inside bold', () => {
    const c = claims('**Tomatoes need sun.** Basil needs warm soil [2].');
    expect(c.map((x) => x.text)).toEqual(['Tomatoes need sun. ', 'Basil needs warm soil .']);
    expect(c[0]!.markdown).toBe('**Tomatoes need sun.** ');
  });

  it('tiles the reply: the Markdown of the claims joined is the reply without citations', () => {
    const reply = '- **Tomatoes**: sun [1].\n- _Basil_: warm `soil` [2].\n\nMint goes in a pot.';
    const c = claims(reply);
    expect(c.map((x) => x.markdown ?? x.text).join('')).toBe(reply.replace(/\[\d\]/g, ''));
    expect(claimsText(c)).toBe('- **Tomatoes**: sun .[1]\n- _Basil_: warm `soil` .[2]\n\nMint goes in a pot.');
  });
});

describe('verification reads the text without Markdown', () => {
  const options: VerifyOptions = {
    cjk: true,
    leadIn: true,
    question: ['What do the plants need?'],
    stripQuestion: true,
  };
  const outcome = (answer: string) =>
    verifyClaims(claims(answer), passages, options).claims.map((c) => ({
      text: c.text.trim(),
      citations: c.citations,
      unsupported: c.unsupported,
      support: c.support,
      leadIn: c.leadIn ?? false,
    }));

  it('gives the same scores and outcomes with and without the formatting', () => {
    const md =
      '**Needs:**\n* **Tomatoes** need `full sun` and water twice a week [1].\n* *Basil* grows in warm soil [3].\n* Mint is purple and tall.';
    const bare =
      'Needs:\nTomatoes need full sun and water twice a week [1].\nBasil grows in warm soil [3].\nMint is purple and tall.';
    expect(outcome(md)).toEqual(outcome(bare));
    const out = outcome(md);
    // The bold lead-in is a lead-in, as its plain form is; the misattributed item moves to [2].
    expect(out[0]).toMatchObject({ text: 'Needs:', leadIn: true });
    expect(out[2]).toMatchObject({ citations: [2], unsupported: false });
    expect(out[3]).toMatchObject({ unsupported: true });
  });

  it('counts no list number as a token or an unsupported sentence', () => {
    const md = Array.from({ length: 11 }, (_, i) => `${i + 1}. Mint spreads quickly in a pot [3].`).join('\n');
    const v = verifyClaims(claims(md), passages, options);
    expect(v.stats).toMatchObject({ sentences: 11, unsupported: 0 });
    expect(v.claims.every((c) => c.support?.[0] === 1)).toBe(true);
  });
});
