import { describe, expect, it } from 'vitest';
import { displayPath, sectionTitle, withoutLeadingPageNumber } from './display.js';

describe('displayPath', () => {
  it('shows a section cut by page or continued once, under its logical parent', () => {
    expect(displayPath(['Field Guide', 'Garden Birds', 'Garden Birds (page 3)'])).toBe('Field Guide > Garden Birds');
    expect(displayPath(['Garden Birds', 'Garden Birds (continued)', 'Garden Birds (page 4)'])).toBe('Garden Birds');
    expect(displayPath(['Ponds', 'Ponds (Page 12)'])).toBe('Ponds');
  });

  it('keeps distinct levels, and a level that only looks like a part elsewhere', () => {
    expect(displayPath(['Field Guide', 'Garden Birds', 'Feeding'])).toBe('Field Guide > Garden Birds > Feeding');
    expect(displayPath(['Ponds', 'Garden Birds', 'Ponds'])).toBe('Ponds > Garden Birds > Ponds');
    expect(displayPath(['Notes (draft)'])).toBe('Notes (draft)');
  });

  it('falls back to the title, without its part marker', () => {
    expect(displayPath([], 'Hedges (page 2)')).toBe('Hedges');
    expect(displayPath(undefined, 'Hedges')).toBe('Hedges');
    expect(sectionTitle('Hedges (continued)')).toBe('Hedges');
  });
});

describe('withoutLeadingPageNumber', () => {
  it('drops a first line that is only a printed page number', () => {
    expect(withoutLeadingPageNumber('12\nGarden birds visit feeders in winter.')).toBe(
      'Garden birds visit feeders in winter.',
    );
    expect(withoutLeadingPageNumber('iv\n\nPonds attract dragonflies.')).toBe('Ponds attract dragonflies.');
    expect(withoutLeadingPageNumber('  XI  \nHedges shelter small mammals.')).toBe('Hedges shelter small mammals.');
  });

  it('drops a lower-case roman numeral glued to the heading that follows', () => {
    expect(withoutLeadingPageNumber('iiiIntroduction\nThis guide covers garden wildlife.')).toBe(
      'Introduction\nThis guide covers garden wildlife.',
    );
    expect(withoutLeadingPageNumber('xiiGarden Birds')).toBe('Garden Birds');
  });

  it('keeps text that only resembles a page number', () => {
    for (const t of [
      'Garden birds visit feeders.',
      '2026\nAnnual count of garden birds.',
      '1. Feeding\nPut out seed in winter.',
      'iPad users can download the guide.',
      'mixed hedges are best.',
      '3D models of nests are on display.',
      'I saw a robin.',
    ])
      expect(withoutLeadingPageNumber(t)).toBe(t);
  });
});
