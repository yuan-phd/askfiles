import { describe, expect, it } from 'vitest';
import { parseBlocks, plainText, scanInline, streamingCut, syntaxRanges } from './markdown.js';
import { plainText as mainPlainText, syntaxRanges as mainSyntaxRanges } from '../../main/answer/markdown.ts';

const plain = (s) => plainText(s).plain;

describe('plainText', () => {
  it('takes out list markers, emphasis, code backticks and escapes', () => {
    expect(plain('* **Fern**: likes shade.')).toBe('Fern: likes shade.');
    expect(plain('1. Water weekly.\n2. Feed in May.')).toBe('Water weekly.\nFeed in May.');
    expect(plain('  - nested _item_')).toBe('nested item');
    expect(plain('***both***')).toBe('both');
    expect(plain('**outer *inner* outer**')).toBe('outer inner outer');
    expect(plain('Run `pot --size 3` now.')).toBe('Run pot --size 3 now.');
    expect(plain('`` a`b ``')).toBe('a`b');
    expect(plain('\\*not italic\\*')).toBe('*not italic*');
  });

  it('leaves text that only looks like syntax', () => {
    for (const s of [
      '2 * 3 = 6',
      'tomato_seed_list.txt',
      'x ** y',
      '1.5 litres',
      '-3 degrees',
      '**never closed',
      'a `lone backtick',
      '# A heading stays',
      '[a link](https://example.com)',
      '<b>html</b>',
      '| a | b |',
      '---',
    ])
      expect(plain(s)).toBe(s);
  });

  it('closes bold after Chinese punctuation, where CommonMark alone would not', () => {
    expect(plain('**要求：**每周浇水')).toBe('要求：每周浇水');
    expect(plain('施肥**两次**即可')).toBe('施肥两次即可');
  });

  it('maps every plain character back to its place in the source', () => {
    const src = '- **Rose**: sun';
    const { plain: p, map } = plainText(src);
    expect([...p].every((ch, i) => src[map[i]] === ch)).toBe(true);
  });
});

describe('parseBlocks', () => {
  it('nests lists by indentation and keeps paragraphs apart', () => {
    const blocks = parseBlocks('Intro:\n- a\n  - b\n  - c\n- d\n\nAfter.\nNext line.');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'list', 'p']);
    const list = blocks[1];
    expect(list.items).toHaveLength(2);
    expect(list.items[0].lists[0].items).toHaveLength(2);
    expect(blocks[2].lines).toHaveLength(2);
  });

  it('starts a numbered list at its first number and keeps a loose list together', () => {
    const [list] = parseBlocks('3. c\n\n4. d');
    expect(list).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(list.items).toHaveLength(2);
  });
});

describe('streaming', () => {
  it('holds back delimiters at the end and a possible list marker on the last line', () => {
    expect(streamingCut('Text **')).toBe('Text ');
    expect(streamingCut('Text\n1.')).toBe('Text\n');
    expect(streamingCut('Text\n-')).toBe('Text\n');
    expect(streamingCut('Text\n- ')).toBe('Text\n- ');
    expect(streamingCut('Text `')).toBe('Text ');
  });

  it('opens unclosed bold on the last line, but not after a letter or digit', () => {
    const open = scanInline('**Ter', 0, 5, { autoClose: true });
    expect(open.events).toEqual([{ at: 0, kind: 'open', type: 'strong', end: 2 }]);
    expect(scanInline('2*3', 0, 3, { autoClose: true }).events).toEqual([]);
    expect(scanInline('**Ter', 0, 5).events).toEqual([]);
  });
});

// A small fixed-seed generator of strings made of Markdown's sharp edges.
function* fuzz(count) {
  const alphabet = [
    '*',
    '**',
    '_',
    '`',
    '\\',
    '- ',
    '1. ',
    '\n',
    '  ',
    ' ',
    'ab',
    '中文',
    '：',
    '.',
    '3',
    '[1]',
    '\ue000',
  ];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let n = 0; n < count; n++) {
    let s = '';
    const len = 1 + (next() % 14);
    for (let k = 0; k < len; k++) s += alphabet[next() % alphabet.length];
    yield s;
  }
}

describe('the main process copy (src/main/answer/markdown.ts)', () => {
  it('removes exactly the same characters', () => {
    const fixed = ['* **Fern**: likes shade.', '1. a\n2. b', '**要求：**每周', '`a` *b* _c_', '\\*x\\*'];
    for (const s of [...fixed, ...fuzz(3000)]) {
      expect(mainSyntaxRanges(s), JSON.stringify(s)).toEqual(syntaxRanges(s));
      expect(mainPlainText(s)).toEqual(plainText(s));
    }
  });
});
