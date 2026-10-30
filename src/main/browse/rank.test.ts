import { describe, expect, it } from 'vitest';
import { idf, rankSections, sectionFrequency, type FoldedSection } from './rank.js';

const sections: FoldedSection[] = [
  { documentId: 'a', sectionIndex: 1, folded: 'annual leave is 27 days. leave is booked in the hr system.' },
  { documentId: 'a', sectionIndex: 2, folded: 'task teams meet weekly; each task team has a lead.' },
  { documentId: 'b', sectionIndex: 1, folded: '员工每年享有带薪年假二十七天。年假需提前申请。' },
  {
    documentId: 'b',
    sectionIndex: 2,
    folded: 'the hr system holds every record of leave and travel for the whole company.',
  },
];

describe('rankSections', () => {
  it('matches any term, rare terms weigh more, more occurrences score higher', () => {
    const r = rankSections(sections, ['leave', 'task teams'], 10);
    expect(r.map((x) => `${x.documentId}${x.sectionIndex}`)).toEqual(['a2', 'a1', 'b2']);
    expect(r[1]!.terms).toEqual(['leave']);
  });

  it('matches Chinese terms as substrings', () => {
    const r = rankSections(sections, ['年假'], 10);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ documentId: 'b', sectionIndex: 1, terms: ['年假'] });
  });

  it('counts section frequency and limits the result', () => {
    expect(sectionFrequency(sections, 'hr system')).toBe(2);
    expect(idf(4, 1)).toBeGreaterThan(idf(4, 3));
    expect(rankSections(sections, ['leave'], 1)).toHaveLength(1);
    expect(rankSections(sections, [], 5)).toEqual([]);
  });
});
