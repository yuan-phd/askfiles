// The owner's summary of exported test records (docs/test-build.md), on a synthetic record written
// by the record code itself (src/main/test-record/record.ts) and exported in both modes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pageRecord, questionRecord, TestRecord } from '../../src/main/test-record/record.ts';
import { referenceKind, summarize } from './summarize.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-summarize-'));
  dirs.push(d);
  return d;
}

const card = (file, display, sectionPath) => ({
  n: 1,
  file,
  display,
  relPath: file,
  url: `file:///x/${file}`,
  documentId: '0123456789abcdef',
  sectionIndex: 1,
  title: sectionPath.at(-1),
  path: sectionPath,
  pageStart: 4,
  pageEnd: 4,
  pageLabel: null,
  passage: 'text',
  rerank: 0.5,
  trimmed: false,
});

function answered(question, o = {}) {
  const cited = o.cited ?? [];
  return {
    question,
    retrieval: o.named ? { crossDocument: { documentIds: ['a', 'b'], files: o.named, quota: ['a#1', 'b#1'] } } : null,
    result: o.error
      ? null
      : {
          text: o.notFound ? 'Not found in your documents.' : 'An answer [1].',
          notFound: !!o.notFound,
          claims: Array.from({ length: (o.starred ?? 0) + 1 }, (_, i) => ({
            text: `s${i}`,
            citations: i ? [] : [1],
            unsupported: i > 0,
          })),
          cited,
          considered: [],
          nearest: [],
          checked: [],
          skippedModel: false,
          timings: { firstTokenMs: 1, modelMs: 1 },
          stats: { promptTokens: 1, completionTokens: 1 },
          questionSent: o.sent ?? question,
        },
    error: o.error ?? null,
    cancelled: false,
    totalMs: o.ms ?? 4000,
  };
}

/** Two testers' exports: one full, one questions only, plus a second export of the first record. */
function syntheticRecords() {
  const out = tmp();
  let t = Date.UTC(2026, 10, 10, 9, 0, 0);
  const at = () => new Date((t += 60_000));
  const guidance = card('Contract Management Guidance.pdf', 'the Contract Management Guidance', ['4 Planning', 'Plan']);
  const handbook = card('staff-handbook.docx', 'Staff Handbook', ['Leave']);

  const anna = new TestRecord(tmp(), { now: () => new Date(2026, 10, 12, 9, 0, 0) });
  anna.append(
    questionRecord(answered('How many days of leave are in staff-handbook.docx?', { cited: [handbook] }), 'Work', at()),
  );
  anna.append(
    questionRecord(
      answered('What does the Contract Management Guidance say about the plan?', { cited: [guidance], starred: 2 }),
      'Work',
      at(),
    ),
  );
  anna.append(
    questionRecord(
      answered('Compare the guidance and the handbook on reviews', {
        named: ['Contract Management Guidance.pdf', 'staff-handbook.docx'],
        cited: [guidance, handbook],
        starred: 1,
      }),
      'Work',
      at(),
    ),
  );
  anna.append(questionRecord(answered('Who signs off?', { notFound: true }), 'Work', at()));
  anna.append(pageRecord({ type: 'browse', page: 'library' }, 'Work', at()));
  anna.append(pageRecord({ type: 'browse', page: 'document', document: 'Staff Handbook' }, 'Work', at()));
  anna.append(pageRecord({ type: 'browse', page: 'document', document: 'Staff Handbook' }, 'Work', at()));
  anna.append(
    pageRecord({ type: 'source', action: 'read', file: 'staff-handbook.docx', section: 'Leave' }, 'Work', at()),
  );
  anna.append({ v: 1, type: 'add', time: at().toISOString(), library: 'Work', kind: 'folder', added: 1, skipped: 0 });
  anna.export('full', out, { version: '0.1.0', platform: 'darwin' });
  anna.export('questions', out, { version: '0.1.0', platform: 'darwin' });

  const ben = new TestRecord(tmp(), { now: () => new Date(2026, 10, 12, 10, 0, 0) });
  ben.append(questionRecord(answered('这份指南对合同管理计划有什么要求？', { ms: 9000 }), '工作', at()));
  ben.append(questionRecord(answered('What is the budget?', { error: 'The library is not ready yet.' }), '工作', at()));
  ben.append(pageRecord({ type: 'browse', page: 'find' }, '工作', at()));
  ben.append(pageRecord({ type: 'browse', page: 'library' }, '工作', at()));
  ben.append(pageRecord({ type: 'browse', page: 'library' }, '工作', at()));
  ben.export('questions', out, { version: '0.1.0', platform: 'win32' });
  fs.writeFileSync(path.join(out, 'notes.txt'), 'not an export');
  return out;
}

describe('referenceKind', () => {
  const names = {
    files: new Set(['Contract Management Guidance.pdf', 'staff-handbook.docx']),
    displays: new Set(['the Staff Handbook']),
  };
  it.each([
    ['What is in budget-2026.xlsx?', 'file name'],
    ['How many days of leave are in staff-handbook.docx?', 'file name'],
    ['Leave rules in staff handbook', 'display name'],
    ['What does Contract Management Guidance say?', 'file name'],
    ['What does the guidance say about plans?', 'description'],
    ['这份指南怎么说？', 'description'],
    ['《采购管理办法》第三条是什么？', 'description'],
    ['Who signs off?', 'none'],
    ['What is the budget?', 'none'],
  ])('%s', (q, kind) => expect(referenceKind(q, names)).toBe(kind));
});

describe('summarize', () => {
  it('prints every question, its file references, named-file detection, outcomes and Browse pages', () => {
    const { text, stats } = summarize(syntheticRecords());
    expect(stats).toEqual({
      exports: 3,
      questions: 6,
      refs: { 'file name': 1, 'display name': 1, description: 2, none: 2 },
      named: 1,
      refusals: 1,
      starred: 3,
      browse: { library: 3, document: 2, find: 1 },
    });
    for (const q of [
      'How many days of leave are in staff-handbook.docx?',
      'What does the Contract Management Guidance say about the plan?',
      'Compare the guidance and the handbook on reviews',
      'Who signs off?',
      '这份指南对合同管理计划有什么要求？',
      'What is the budget?',
    ])
      expect(text).toContain(q);
    expect(text).toContain('3 exported files, 14 lines, 6 questions.');
    expect(text).toContain('## Named-file detection fired (1 of 6)');
    expect(text).toContain('| Contract Management Guidance.pdf, staff-handbook.docx | 2 sections | no |');
    expect(text).toContain('Refusals: 1.');
    expect(text).toContain('Starred sentences: 3 in 2 of 4 answers.');
    expect(text).toMatch(/\| library \| 3 \|\n\| document \| 2 \|\n\| find \| 1 \|/);
    expect(text).toContain('| Staff Handbook | 2 |');
    expect(text).toContain('Source card clicks: 1 (read 1).');
    expect(text).toContain('Adds: 1 (1 files or folders added, 0 skipped).');
    expect(text).toContain('| error | 1 |');
  });

  it('runs from the command line', () => {
    const dir = syntheticRecords();
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'summarize.mjs'), dir], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^# Test record summary/);
    const bad = spawnSync(process.execPath, [path.join(import.meta.dirname, 'summarize.mjs')], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });
});
