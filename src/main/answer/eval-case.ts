/**
 * Save as eval case from the developer panel: appends the question and the section the owner
 * clicked to an eval questions CSV in the format scripts/eval reads (docs/eval.md).
 */
import fs from 'node:fs';
import path from 'node:path';

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

/** Separator between headings in expected_section_path, as the source cards print a path. */
export const PATH_SEPARATOR = ' > ';

export interface EvalCase {
  question: string;
  file: string;
  path: string[];
  pageStart: number | null;
}

export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:T.Z]/g, '');
}

/**
 * Appends one row, writing the header first when the file is new. An existing file keeps its own
 * column order; columns it lacks are left out. Returns the new row's id.
 */
export function appendEvalCase(file: string, c: EvalCase, now = new Date()): string {
  const id = `case-${stamp(now)}`;
  const row: Record<string, string> = {
    id,
    category: 'single_fact',
    question: c.question.trim(),
    expected_answer: '',
    expected_source_file: c.file,
    expected_section: c.path[c.path.length - 1] ?? '',
    expected_section_path: c.path.join(PATH_SEPARATOR),
    expected_page: c.pageStart ? String(c.pageStart) : '',
    key_elements: '',
    notes: 'saved from the developer panel; fill in expected_answer and key_elements',
  };
  let header: string[] = [...QUESTION_COLUMNS];
  let prefix = '';
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const text = fs.readFileSync(file, 'utf8');
    header = text
      .split(/\r?\n/, 1)[0]!
      .split(',')
      .map((h) => h.trim().replace(/^\uFEFF/, ''));
    if (!text.endsWith('\n')) prefix = '\n';
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    prefix = `${header.join(',')}\n`;
  }
  fs.appendFileSync(file, `${prefix}${header.map((h) => csvCell(row[h] ?? '')).join(',')}\n`);
  return id;
}
