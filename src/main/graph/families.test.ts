import { describe, expect, it } from 'vitest';
import { dateIn, documentDate, frontMatterDate } from './dates.js';
import { closeKeys, detectFamilies, familyKey, pairKey, versionNumber } from './families.js';
import { doc } from './__fixtures__/docs.js';

const D = (s: string) => Date.parse(`${s}T00:00:00Z`);

describe('family keys and dates', () => {
  it('ignores the leading file number, years, versions and the format', () => {
    expect(familyKey('04_必须招标的工程项目规定.pdf')).toBe(familyKey('13_必须招标的工程项目规定.docx'));
    expect(familyKey('Procurement Regulations 2024.pdf')).toBe(familyKey('Procurement_Regulations_2025.pdf'));
    expect(familyKey('leave-policy-v1.md')).toBe(familyKey('leave-policy-v2.md'));
    expect(familyKey('标准设备采购招标文件_2017年版.pdf')).toBe('标准设备采购招标文件');
    expect(familyKey('Report (2).pdf')).toBe(familyKey('Report.pdf'));
    expect(familyKey('2024.pdf')).toBe('');
    expect(familyKey('Procurement Policy.pdf')).not.toBe(familyKey('Procurement Procedure.pdf'));
  });

  it('reads dates from titles and front matter', () => {
    expect(dateIn('Minutes 2026-03-04')).toBe('2026-03-04');
    expect(dateIn('Minutes 20260304')).toBe('2026-03-04');
    expect(dateIn('会议纪要 2026年3月4日')).toBe('2026-03-04');
    expect(dateIn('Board pack March 2026')).toBe('2026-03');
    expect(dateIn('Regulations 2025')).toBe('2025');
    expect(dateIn('Version 2.1')).toBeNull();
    expect(frontMatterDate('---\ntitle: Kickoff\ndate: 2026-03-04\n---\n\nBody')).toBe('2026-03-04');
    expect(documentDate(doc('kickoff.md', [['kickoff', '---\ndate: 2026-02-01\n---']], { levels: [0] }))).toEqual({
      value: '2026-02-01',
      source: 'front matter',
    });
    expect(versionNumber('Leave policy v2.md')).toBe(2);
  });

  it('asks about close titles only', () => {
    expect(closeKeys('leavepolicy', 'leavepolicies')).toBe(true);
    expect(closeKeys('procurementplan', 'procurementplans')).toBe(true);
    expect(closeKeys('procurementpolicy', 'procurementprocedure')).toBe(false);
    expect(closeKeys('budget', 'budget')).toBe(false);
  });
});

describe('families', () => {
  const pdf = doc('04_必须招标的工程项目规定.pdf', [['第一条', '为了确定必须招标的工程项目，制定本规定。']]);
  const word = doc('13_必须招标的工程项目规定.docx', [['第一条', '为了确定必须招标的工程项目，制定本规定。']]);
  const y24 = doc('Procurement Regulations 2024.pdf', [['Scope', 'a']], { mtimeMs: D('2026-05-01') });
  const y25 = doc('Procurement Regulations 2025.pdf', [['Scope', 'b']], { mtimeMs: D('2025-01-01') });
  const other = doc('Value for Money Guidance.pdf', [['Scope', 'c']]);

  it('groups the PDF and Word copy of one regulation, and the 2024 and 2025 issues, oldest first', () => {
    const r = detectFamilies([y25, other, pdf, y24, word]);
    expect(r.families).toHaveLength(2);
    const regs = r.families.find((f) => f.members.includes(y24.id))!;
    // By the year in the title, not by the file time (the 2025 file is older on disk).
    expect(regs.members).toEqual([y24.id, y25.id]);
    expect(r.familyOf.get(pdf.id)).toBe(r.familyOf.get(word.id));
    expect(r.familyOf.has(other.id)).toBe(false);
    expect(r.questions).toEqual([]);
  });

  it('lists a close pair as a question, and follows the answers both ways', () => {
    const a = doc('Leave policy.md', [['x', 'a']]);
    const b = doc('Leave policies.md', [['x', 'b']]);
    const asked = detectFamilies([a, b]);
    expect(asked.families).toEqual([]);
    expect(asked.questions).toEqual([a.id < b.id ? { a: a.id, b: b.id } : { a: b.id, b: a.id }]);
    const joined = detectFamilies([a, b], { [pairKey(a.id, b.id)]: true });
    expect(joined.questions).toEqual([]);
    expect(joined.families[0]!.members.sort()).toEqual([a.id, b.id].sort());
    const kept = detectFamilies([a, b], { [pairKey(a.id, b.id)]: false });
    expect(kept.questions).toEqual([]);
    expect(kept.families).toEqual([]);
    // A no splits a pair detection had joined.
    const split = detectFamilies([pdf, word], { [pairKey(pdf.id, word.id)]: false });
    expect(split.families).toEqual([]);
  });
});
