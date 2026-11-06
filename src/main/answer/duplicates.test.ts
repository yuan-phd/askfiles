import { describe, expect, it } from 'vitest';
import { duplicateGroups, nameMatcher, normalizedText, shareDuplicates, textHashOf } from './duplicates.js';
import type { Claim } from './citations.js';

const claim = (citations: number[], text = 'x'): Claim => ({ text, citations, unsupported: citations.length === 0 });

describe('duplicateTextAttribution (round D4)', () => {
  it('normalizes: NFKC, full-width to half-width, whitespace and ASCII and CJK punctuation removed', () => {
    expect(normalizedText('投标人在 10 日前提出：\n\n  “答复”。\n- 23 -\n')).toBe('投标人在10日前提出答复23');
    expect(normalizedText('Ａ  b,\nc.（第１条）【附件】《范本》、——…·')).toBe('Abc第1条附件范本');
    expect(normalizedText('Sec. 4.6: "Plan" (a)/[b]_{c}!?')).toBe('Sec46Planabc');
    // Letters and digits are never altered: Chinese and Arabic numerals stay different.
    expect(normalizedText('第五条')).not.toBe(normalizedText('第5条'));
    expect(normalizedText('〇々')).toBe('〇々');
    // One character apart is a different text: equality by hash only, never by similarity.
    expect(textHashOf('应当在投标截止时间10日前')).not.toBe(textHashOf('应当在投标截止时间15日前'));
    expect(textHashOf('第五条　全部或者部分使用国有资金投资，\n施工单项合同估算价在400万元人民币以上；')).toBe(
      textHashOf('第五条 全部或者部分使用国有资金投资 施工单项合同估算价在400万元人民币以上'),
    );
  });

  it('groups only sections with equal hashes and a normalized text of 50 characters or more', () => {
    const long = 'x'.repeat(50);
    const g = duplicateGroups([long, 'other', `${long.slice(0, 25)} , ${long.slice(25)}`, '', '  ', 'short', 'short']);
    expect([...g.entries()]).toEqual([
      [1, [3]],
      [3, [1]],
    ]);
    // 49 characters after normalization: never part of the rule, even when identical.
    const s49 = `${'y'.repeat(49)}。`;
    expect(duplicateGroups([s49, s49]).size).toBe(0);
    expect(duplicateGroups([`${s49}y`, `${s49}y`]).size).toBe(2);
  });

  it('a sentence attributed to one copy is attributed to both; uncited sentences stay as they are', () => {
    const c24 = 'clause 2.4 text '.repeat(5);
    const passages = [c24, 'something else', c24.replace(/ /g, '  ')].map((passage, i) => ({
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
    const clause =
      '投标人或者其他利害关系人对招标文件有异议的，应当在投标截止时间10日前以书面形式提出。招标人应当自收到异议之日起3日内作出答复；作出答复前，应当暂停招标投标活动。';
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
