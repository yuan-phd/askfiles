import { describe, expect, it } from 'vitest';
import { claimsSource, streamingSource, tightEnd } from './answer-source.js';
import { claimsOf, parseCitations } from '../../main/answer/citations.ts';
import { parseBlocks, plainText } from '../shared/markdown.js';

const make = { cite: (n) => `cite ${n}`, mark: () => 'mark', span: (c) => c.text };
const nodeAt = (r, ch) => r.nodes.get(ch)?.();

describe('claimsSource', () => {
  it('puts the dagger after the last word of an unsupported list item, on its own line', () => {
    const claims = [
      { text: 'Two herbs:\n', citations: [], unsupported: false, leadIn: true },
      { text: 'Basil: sun.\n', markdown: '- **Basil**: sun.\n', citations: [1], unsupported: false },
      { text: 'Mint: anywhere.', markdown: '- **Mint**: anywhere.', citations: [], unsupported: true },
    ];
    const r = claimsSource(claims, make);
    const lines = r.src.split('\n');
    expect(lines).toHaveLength(3);
    // The marker is the last character before the trailing space of the last item.
    const last = lines[2].trimEnd();
    expect(nodeAt(r, last.at(-1))).toBe('mark');
    expect(last.startsWith('- **Mint**: anywhere.')).toBe(true);
    // The citation stays inside the second item, before its line break.
    expect(nodeAt(r, lines[1].trimEnd().at(-1))).toBe('cite 1');
    // Still a list of two items, and the marker is no Markdown: the plain text keeps it.
    const blocks = parseBlocks(r.src);
    expect(blocks.map((b) => b.type)).toEqual(['p', 'list']);
    expect(blocks[1].items).toHaveLength(2);
    expect(plainText(r.src).plain).toContain(`anywhere.${last.at(-1)}`);
  });

  it('puts the dagger after the closing ** of a sentence in bold, never between asterisks', () => {
    const claims = [{ text: 'Prune in March.', markdown: '**Prune in March.**', citations: [], unsupported: true }];
    const r = claimsSource(claims, make);
    expect(r.src.startsWith('**Prune in March.**')).toBe(true);
    expect(nodeAt(r, r.src.trimEnd().at(-1))).toBe('mark');
    expect(plainText(r.src).plain.trimEnd()).toBe(`Prune in March.${r.src.trimEnd().at(-1)}`);
  });

  it('gives each claim its stretch of the source, and no marker to a supported claim', () => {
    const claims = [
      { text: 'Water weekly. ', citations: [2], unsupported: false },
      { text: 'Feed in May.', citations: [], unsupported: true },
    ];
    const r = claimsSource(claims, make);
    expect(r.spans.map((s) => [s.from, s.to])).toEqual([
      [0, 15],
      [15, r.src.length],
    ]);
    expect([...r.nodes.values()].map((f) => f())).toEqual(['cite 2', 'mark']);
  });

  it('drops private-use characters an answer brings itself', () => {
    const r = claimsSource([{ text: 'Odd \ue000 text.', citations: [], unsupported: false }], make);
    expect(r.src).toBe('Odd  text. ');
  });
});

describe('streamingSource', () => {
  it('keeps citations where they came', () => {
    const r = streamingSource(
      [
        { type: 'text', text: '- **Rose** ' },
        { type: 'cite', n: 3 },
      ],
      (n) => `cite ${n}`,
    );
    expect(r.src.slice(0, 11)).toBe('- **Rose** ');
    expect(nodeAt(r, r.src.at(-1))).toBe('cite 3');
  });
});

// The spacing rule end to end: a reply as the model writes it, its claims as the pipeline makes
// them (claimsOf), and the text the Ask page shows, with [n] for a citation and the dagger.
describe('text, punctuation, citations, dagger (display spacing)', () => {
  const shown = (claims) => {
    const r = claimsSource(claims, { cite: (n) => `[${n}]`, mark: () => '†', span: () => null });
    return [...plainText(r.src).plain].map((ch) => r.nodes.get(ch)?.() ?? ch).join('');
  };
  const reply = (text, max = 3) => shown(claimsOf(parseCitations(text), max));

  it('puts the citation after the full stop, wherever the model wrote it', () => {
    for (const text of [
      'Water weekly [2].',
      'Water weekly[2].',
      'Water weekly.[2]',
      'Water weekly. [2]',
      'Water weekly [2] .',
      'Water weekly .[2]',
    ])
      expect(reply(text).trim(), text).toBe('Water weekly.[2]');
  });

  it('puts the dagger right after the full stop, and after the citations', () => {
    expect(reply('Mint spreads fast .').trim()).toBe('Mint spreads fast.†');
    expect(reply('Mint spreads fast.').trim()).toBe('Mint spreads fast.†');
    const both = [{ text: 'Water weekly .', citations: [2], unsupported: true }];
    expect(shown(both).trim()).toBe('Water weekly.[2]†');
  });

  it('does the same in Chinese', () => {
    for (const text of ['每周浇水两次[2]。', '每周浇水两次 [2] 。', '每周浇水两次。[2]', '每周浇水两次 。[2]'])
      expect(reply(text).trim(), text).toBe('每周浇水两次。[2]');
    expect(reply('可能不准确 。').trim()).toBe('可能不准确。†');
  });

  it('holds inside list items and bold text', () => {
    expect(reply('- Water weekly [2].\n- Feed monthly [1].')).toBe('Water weekly.[2]\nFeed monthly.[1] ');
    expect(reply('1. **Water weekly** [2].').trim()).toBe('Water weekly.[2]');
    expect(reply('**Water weekly [2].**').trim()).toBe('Water weekly.[2]');
    expect(reply('- **Mint spreads fast** .').trim()).toBe('Mint spreads fast.†');
  });

  it('leaves a sentence without closing punctuation and the space inside a sentence alone', () => {
    expect(reply('- Water weekly [2]').trim()).toBe('Water weekly[2]');
    expect(reply('Prune , then water weekly [2].').trim()).toBe('Prune , then water weekly.[2]');
  });

  it('changes only the display: the claims keep their text', () => {
    const claims = claimsOf(parseCitations('Water weekly [2].'), 3);
    shown(claims);
    expect(claims[0]).toMatchObject({ text: 'Water weekly .', citations: [2] });
  });
});

describe('tightEnd', () => {
  it('closes the gap before the closing punctuation, also across emphasis delimiters', () => {
    expect(tightEnd('Water weekly .')).toBe('Water weekly.');
    expect(tightEnd('**Water weekly .**')).toBe('**Water weekly.**');
    expect(tightEnd('**Water weekly** .')).toBe('**Water weekly**.');
    expect(tightEnd('要求如下 ：')).toBe('要求如下：');
    expect(tightEnd('Water weekly')).toBe('Water weekly');
    expect(tightEnd('Water weekly.')).toBe('Water weekly.');
  });
});
