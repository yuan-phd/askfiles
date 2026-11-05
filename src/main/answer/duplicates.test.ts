import { describe, expect, it } from 'vitest';
import { duplicateGroups, nameMatcher, normalizedText, shareDuplicates, textHashOf } from './duplicates.js';
import type { Claim } from './citations.js';

const claim = (citations: number[], text = 'x'): Claim => ({ text, citations, unsupported: citations.length === 0 });

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
    const passages = ['clause 2.4 text', 'something else', 'clause 2.4  text'].map((passage, i) => ({
      passage,
      file: `f${i}.pdf`,
    }));
    const r = shareDuplicates([claim([1]), claim([2]), claim([]), claim([3, 1])], passages);
    expect(r.claims.map((c) => c.citations)).toEqual([[1, 3], [2], [], [3, 1]]);
    expect(r.claims[2]!.unsupported).toBe(true);
    expect(r.shared).toBe(1);
  });

  it('changes nothing without duplicates', () => {
    const claims = [claim([1])];
    expect(
      shareDuplicates(claims, [
        { passage: 'a', file: 'a.pdf' },
        { passage: 'b', file: 'b.pdf' },
      ]).claims,
    ).toBe(claims);
  });

  describe('tiers (round D4b), two duplicate sections', () => {
    const clause = '投标人或者其他利害关系人对招标文件有异议的，应当在投标截止时间10日前以书面形式提出。';
    const sources = [
      { passage: clause, file: '01_标准设备采购招标文件_2017年版.pdf' },
      { passage: '其他条款。', file: '03_标准勘察招标文件_2017年版.pdf' },
      { passage: clause, file: '02_标准材料采购招标文件_2017年版.pdf' },
    ];
    const both = '对比《标准设备采购招标文件》和《标准材料采购招标文件》：异议的最迟时间是什么？';
    const one = '《标准材料采购招标文件》中异议的最迟时间是什么？';
    const none = '异议的最迟时间是什么？';

    it('a. the sentence names one document by its display name or 《》 form: only its section', () => {
      const r = shareDuplicates(
        [
          claim([1], '《标准材料采购招标文件》规定10日前提出。'),
          claim([1], '标准设备采购招标文件 2017年版规定10日前提出。'),
        ],
        sources,
        { question: [both] },
      );
      expect(r.claims.map((c) => c.citations)).toEqual([[3], [1]]);
      expect(r.tiers).toEqual({ sentence: 2, question: 0, all: 0 });
    });

    it('b. else the question names exactly one: its section', () => {
      const r = shareDuplicates([claim([1], '应在投标截止时间10日前提出。')], sources, { question: [one] });
      expect(r.claims[0]!.citations).toEqual([3]);
      expect(r.tiers).toEqual({ sentence: 0, question: 1, all: 0 });
    });

    it('c. else all sections with the equal hash; a sentence naming both falls through as well', () => {
      const plain = shareDuplicates([claim([1], '应在投标截止时间10日前提出。')], sources, { question: [both] });
      expect(plain.claims[0]!.citations).toEqual([1, 3]);
      const unnamed = shareDuplicates([claim([3], '应在10日前提出。')], sources, { question: [none] });
      expect(unnamed.claims[0]!.citations).toEqual([3, 1]);
      const named = shareDuplicates([claim([1], '《标准设备采购招标文件》和《标准材料采购招标文件》一致。')], sources, {
        question: [none],
      });
      expect(named.claims[0]!.citations).toEqual([1, 3]);
      expect(named.tiers).toEqual({ sentence: 0, question: 0, all: 1 });
    });

    it('a short form the display name does not contain is not a name (设备采购招标文件)', () => {
      const r = shareDuplicates([claim([1], '设备采购招标文件中，下一项排序依据是技术得分。')], sources, {
        question: [none],
      });
      expect(r.claims[0]!.citations).toEqual([1, 3]);
    });

    it('English names match whole words in any case; the question may name the file', () => {
      const m = nameMatcher('01_Procurement_Regulations_2025.pdf');
      expect(m.sentence('Under the procurement regulations 2025, ...')).toBe(true);
      expect(m.sentence('Procurement Regulations 20251')).toBe(false);
      expect(m.question('Compare `01_Procurement_Regulations_2025.pdf` and ...')).toBe(true);
    });
  });
});
