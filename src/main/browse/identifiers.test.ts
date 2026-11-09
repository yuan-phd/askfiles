import { describe, expect, it } from 'vitest';
import { doc } from '../graph/__fixtures__/docs.js';
import {
  buildIdentities,
  compileMatchers,
  libraryDisplayNames,
  mentionedDocuments,
  namedFileGroups,
  rewriteFileNames,
  warmMatchers,
} from './identifiers.js';

// Invented documents only (CLAUDE.md rule 10).
const invented = () =>
  buildIdentities([
    doc('01_Pump_Station_Procedure_2025.pdf', [['Isolation', 'x']]),
    doc('Pump Station Procedure 2025.docx', [['Isolation', 'x']]),
    doc('Valve Exercising Guidance.pdf', [['Valves', 'x']]),
    doc('Fleet Plan.md', [['Vehicles', 'x']]),
    doc('水务合作社泵站维护规程.pdf', [['检修', 'x']]),
  ]);
const QUESTIONS = [
  'What does the Pump Station Procedure 2025 say about isolation?',
  'Compare the valve exercising guidance with the Fleet Plan.',
  'pump_station_procedure and Valve Exercising Guidance',
  '《水务合作社泵站维护规程》 的检修要求',
  '水务合作社 泵站维护规程 和 Fleet Plan',
  'Nothing named here.',
];
const detect = (list: ReturnType<typeof invented>) =>
  QUESTIONS.map((q) => [
    mentionedDocuments(q, list).map((f) => f.file),
    namedFileGroups(q, list).map((g) => g.map((f) => f.file)),
  ]);

describe('name matchers (built once per identity list)', () => {
  it('detects the same files built on first use, compiled up front, or warmed in the background', async () => {
    const lazy = detect(invented());
    const compiled = invented();
    compileMatchers(compiled);
    const warmed = invented();
    await warmMatchers(warmed, () => true, 1);
    expect(detect(compiled)).toEqual(lazy);
    expect(detect(warmed)).toEqual(lazy);
    // A question asked twice with one shared matcher gets the same result (no regex state kept).
    expect(detect(compiled)).toEqual(lazy);
    expect(lazy[0]![1]).toEqual([['01_Pump_Station_Procedure_2025.pdf', 'Pump Station Procedure 2025.docx']]);
    expect(lazy[5]).toEqual([[], []]);
  });

  it('the background warm-up stops once the identity list is replaced', async () => {
    const list = invented();
    let checks = 0;
    await warmMatchers(list, () => ++checks < 2, 0);
    expect(checks).toBe(2);
  });
});

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
