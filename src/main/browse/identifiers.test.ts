import { describe, expect, it } from 'vitest';
import { libraryDisplayNames, rewriteFileNames } from './identifiers.js';

describe('libraryDisplayNames (displayFormatSuffix, round P2)', () => {
  it('labels files that share a display name and differ in format, in the name language', () => {
    const n = libraryDisplayNames([
      '04_必须招标的工程项目规定.pdf',
      '13_必须招标的工程项目规定.docx',
      '10_Procurement_Plan.pdf',
      '11_Procurement_Plan.docx',
      '12_Procurement_Plan.xlsx',
      '01_Procurement_Regulations_2025.pdf',
    ]);
    expect(n.get('04_必须招标的工程项目规定.pdf')).toBe('必须招标的工程项目规定 PDF版');
    expect(n.get('13_必须招标的工程项目规定.docx')).toBe('必须招标的工程项目规定 Word版');
    expect(n.get('10_Procurement_Plan.pdf')).toBe('Procurement Plan (PDF)');
    expect(n.get('11_Procurement_Plan.docx')).toBe('Procurement Plan (Word)');
    expect(n.get('12_Procurement_Plan.xlsx')).toBe('Procurement Plan (XLSX)');
    expect(n.get('01_Procurement_Regulations_2025.pdf')).toBe('Procurement Regulations 2025');
  });

  it('leaves same-format files with one name unlabelled, and the question rewrite uses the names given', () => {
    const n = libraryDisplayNames(['01_Plan_Notes.pdf', '02_Plan_Notes.pdf']);
    expect([...n.values()]).toEqual(['Plan Notes', 'Plan Notes']);
    const files = ['04_必须招标的工程项目规定.pdf', '13_必须招标的工程项目规定.docx'];
    const names = libraryDisplayNames(files);
    expect(rewriteFileNames('请看`13_必须招标的工程项目规定.docx`第二条', files, (f) => names.get(f)!)).toBe(
      '请看必须招标的工程项目规定 Word版第二条',
    );
  });
});
