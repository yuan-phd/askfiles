import { describe, expect, it } from 'vitest';
import { claimsSource, streamingSource } from './answer-source.js';
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
