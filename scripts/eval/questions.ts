import fs from 'node:fs';
import { parseRecords } from './csv.js';

export const CATEGORIES = [
  'single_fact',
  'middle_of_long_doc',
  'cross_document',
  'table_number',
  'absent_related',
  'absent_unrelated',
  'version',
  'section_listing',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const ABSENT: readonly Category[] = ['absent_related', 'absent_unrelated'];

export const QUESTION_COLUMNS = [
  'id',
  'category',
  'question',
  'expected_answer',
  'expected_source_file',
  'expected_section',
  'expected_section_path',
  'expected_page',
  'key_elements',
  'notes',
] as const;

export interface Question {
  id: string;
  category: Category;
  question: string;
  expected_answer: string;
  expected_source_file: string;
  expected_section: string;
  /** Headings from the outside in, separated by >; several sections separated by semicolons. */
  expected_section_path: string;
  expected_page: string;
  /** Phrases a correct answer contains, separated by semicolons (docs/eval.md). */
  key_elements: string;
  notes: string;
}

/** A list cell: values separated by semicolons (ASCII or full-width), blanks dropped. */
export function listOf(cell: string | undefined): string[] {
  return (cell ?? '')
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expected pages as numbers; a range such as 4-6 expands to 4, 5, 6. */
export function pagesOf(cell: string | undefined): number[] {
  const out: number[] = [];
  for (const part of listOf(cell)) {
    const m = /^(\d+)\s*(?:-|–|to)\s*(\d+)$/.exec(part);
    if (m) for (let p = Number(m[1]); p <= Number(m[2]); p++) out.push(p);
    else if (/^\d+$/.test(part)) out.push(Number(part));
    else throw new Error(`expected_page value ${JSON.stringify(part)} is not a page number or range`);
  }
  return out;
}

/** Parses and checks a questions CSV. Throws one error listing every problem found. */
export function parseQuestions(text: string): Question[] {
  const { header, records } = parseRecords(text);
  const problems: string[] = [];
  for (const col of ['id', 'category', 'question']) {
    if (!header.includes(col)) problems.push(`missing column ${col}`);
  }
  if (problems.length) throw new Error(`questions CSV: ${problems.join('; ')}`);
  const seen = new Set<string>();
  const questions = records.map((r, i) => {
    const line = i + 2;
    const q = Object.fromEntries(QUESTION_COLUMNS.map((c) => [c, (r[c] ?? '').trim()])) as unknown as Question;
    if (!q.id) problems.push(`line ${line}: empty id`);
    else if (seen.has(q.id)) problems.push(`line ${line}: duplicate id ${q.id}`);
    seen.add(q.id);
    if (!(CATEGORIES as readonly string[]).includes(q.category)) {
      problems.push(`line ${line}: unknown category ${JSON.stringify(q.category)}`);
    }
    if (!q.question) problems.push(`line ${line}: empty question`);
    try {
      pagesOf(q.expected_page);
    } catch (e) {
      problems.push(`line ${line}: ${(e as Error).message}`);
    }
    if (q.category === 'section_listing' && !listOf(q.expected_section).length) {
      problems.push(`line ${line}: section_listing needs expected_section`);
    }
    return q;
  });
  if (problems.length) throw new Error(`questions CSV:\n  ${problems.join('\n  ')}`);
  return questions;
}

export function loadQuestions(file: string): Question[] {
  return parseQuestions(fs.readFileSync(file, 'utf8'));
}
