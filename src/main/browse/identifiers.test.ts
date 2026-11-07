import { describe, expect, it } from 'vitest';
import { libraryDisplayNames, rewriteFileNames } from './identifiers.js';

describe('libraryDisplayNames (displayFormatSuffix, round P2)', () => {
  it('labels files that share a display name and differ in format, in the name language', () => {
    const n = libraryDisplayNames([
      '04_必须审批的差旅事项规定.pdf',
      '13_必须审批的差旅事项规定.docx',
      '10_Maintenance_Plan.pdf',
      '11_Maintenance_Plan.docx',
      '12_Maintenance_Plan.xlsx',
      '01_Maintenance_Regulations_2025.pdf',
    ]);
    expect(n.get('04_必须审批的差旅事项规定.pdf')).toBe('必须审批的差旅事项规定 PDF版');
    expect(n.get('13_必须审批的差旅事项规定.docx')).toBe('必须审批的差旅事项规定 Word版');
    expect(n.get('10_Maintenance_Plan.pdf')).toBe('Maintenance Plan (PDF)');
    expect(n.get('11_Maintenance_Plan.docx')).toBe('Maintenance Plan (Word)');
    expect(n.get('12_Maintenance_Plan.xlsx')).toBe('Maintenance Plan (XLSX)');
    expect(n.get('01_Maintenance_Regulations_2025.pdf')).toBe('Maintenance Regulations 2025');
  });

  it('leaves same-format files with one name unlabelled, and the question rewrite uses the names given', () => {
    const n = libraryDisplayNames(['01_Plan_Notes.pdf', '02_Plan_Notes.pdf']);
    expect([...n.values()]).toEqual(['Plan Notes', 'Plan Notes']);
    const files = ['04_必须审批的差旅事项规定.pdf', '13_必须审批的差旅事项规定.docx'];
    const names = libraryDisplayNames(files);
    expect(rewriteFileNames('请看`13_必须审批的差旅事项规定.docx`第二条', files, (f) => names.get(f)!)).toBe(
      '请看必须审批的差旅事项规定 Word版第二条',
    );
  });
});
