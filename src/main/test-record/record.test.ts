// The test build's record (docs/test-build.md): question lines from finished runs, page events
// checked field by field, pause and clear, and the export in both modes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnsweredRun } from '../answer/service.js';
import type { AnswerResult, Retrieval, SourceCard } from '../answer/pipeline.js';
import { exportLine, pageRecord, questionRecord, readRecord, TestRecord, type QuestionRecord } from './record.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-test-record-'));
  dirs.push(d);
  return d;
}

const NOW = new Date('2026-11-07T10:15:30.000Z');

function card(over: Partial<SourceCard> = {}): SourceCard {
  return {
    n: 1,
    file: 'Building Management Guidance.pdf',
    display: 'the Building Management Guidance',
    relPath: 'Building Management Guidance.pdf',
    url: 'file:///x/Building Management Guidance.pdf',
    documentId: '0123456789abcdef',
    sectionIndex: 3,
    title: 'Building Management Plan',
    path: ['4 Planning', 'Building Management Plan'],
    pageStart: 12,
    pageEnd: 13,
    pageLabel: null,
    passage: 'The plan names the contract manager.',
    rerank: 0.8,
    trimmed: false,
    ...over,
  };
}

function result(over: Partial<AnswerResult> = {}): AnswerResult {
  return {
    text: 'The plan names the contract manager [1]. It is reviewed yearly.',
    notFound: false,
    claims: [
      { text: 'The plan names the contract manager [1].', citations: [1], unsupported: false },
      { text: 'It is reviewed yearly.', citations: [], unsupported: true },
    ],
    cited: [card()],
    considered: [],
    nearest: [],
    checked: [],
    skippedModel: false,
    timings: { firstTokenMs: 900, modelMs: 4000 },
    stats: { promptTokens: 100, completionTokens: 20 },
    questionSent: 'What does the plan in Building Management Guidance say?',
    ...over,
  };
}

function run(over: Partial<AnsweredRun> = {}): AnsweredRun {
  return {
    question: 'What does the plan in the guidance say?',
    retrieval: null,
    result: result(),
    error: null,
    cancelled: false,
    totalMs: 5123,
    ...over,
  };
}

const crossDocument = (o: Partial<NonNullable<Retrieval['crossDocument']>> = {}) =>
  ({
    retrieval: {
      crossDocument: { documentIds: ['a', 'b'], files: ['A.pdf', 'B.docx'], quota: ['a#1', 'b#2'], ...o },
    } as unknown as Retrieval,
  }) satisfies Partial<AnsweredRun>;

describe('question records', () => {
  it('records the question, its switches, the answer, the cited sections and the starred sentences', () => {
    const q = questionRecord(run(), 'Work', NOW);
    expect(q).toEqual({
      v: 1,
      type: 'question',
      time: '2026-11-07T10:15:30.000Z',
      library: 'Work',
      question: 'What does the plan in the guidance say?',
      switches: {
        questionRewrite: { fired: true, sent: 'What does the plan in Building Management Guidance say?' },
        namedFiles: { fired: false, files: [] },
        perFileQuota: { fired: false, sections: 0 },
        judgeRerank: { fired: false, files: 0, ms: 0 },
      },
      outcome: 'answer',
      error: null,
      answer: 'The plan names the contract manager [1]. It is reviewed yearly.',
      cited: [
        {
          file: 'Building Management Guidance.pdf',
          display: 'the Building Management Guidance',
          section: '4 Planning > Building Management Plan',
          page: 12,
        },
      ],
      starred: 1,
      totalMs: 5123,
    } satisfies QuestionRecord);
  });

  it('records named-file detection with the files, the per-file quota and the judge', () => {
    const q = questionRecord(
      run({
        ...crossDocument({ judge: { ms: 812.6, files: [{}, {}] as never } }),
        result: result({ questionSent: 'What does the plan in the guidance say?' }),
      }),
      null,
      NOW,
    );
    expect(q.switches).toEqual({
      questionRewrite: { fired: false, sent: null },
      namedFiles: { fired: true, files: ['A.pdf', 'B.docx'] },
      perFileQuota: { fired: true, sections: 2 },
      judgeRerank: { fired: true, files: 2, ms: 813 },
    });
    expect(questionRecord(run({ ...crossDocument({ quota: [] }) }), null, NOW).switches.perFileQuota).toEqual({
      fired: false,
      sections: 0,
    });
  });

  it('tells a refusal, an error and a cancelled question apart', () => {
    const refusal = questionRecord(run({ result: result({ notFound: true, cited: [], claims: [] }) }), null, NOW);
    expect([refusal.outcome, refusal.starred]).toEqual(['refusal', 0]);
    const error = questionRecord(run({ result: null, error: 'The library is not ready yet.' }), null, NOW);
    expect([error.outcome, error.error, error.answer, error.cited]).toEqual([
      'error',
      'The library is not ready yet.',
      null,
      [],
    ]);
    const cancelled = questionRecord(run({ result: null, cancelled: true }), null, NOW);
    expect([cancelled.outcome, cancelled.error, cancelled.answer]).toEqual(['cancelled', null, null]);
  });

  it('shows the file name as the display only when the card showed something else', () => {
    const q = questionRecord(
      run({ result: result({ cited: [card({ display: 'Building Management Guidance.pdf', path: [] })] }) }),
      null,
      NOW,
    );
    expect(q.cited[0]).toMatchObject({ display: null, section: 'Building Management Plan' });
  });
});

describe('page events', () => {
  it('keeps a Browse page and a source card click, with only their known fields', () => {
    expect(pageRecord({ type: 'browse', page: 'document', document: 'Handbook', extra: 'x' }, 'Work', NOW)).toEqual({
      v: 1,
      type: 'browse',
      time: NOW.toISOString(),
      library: 'Work',
      page: 'document',
      document: 'Handbook',
    });
    expect(pageRecord({ type: 'browse', page: 'find', document: 'Handbook' }, null, NOW)).toMatchObject({
      page: 'find',
      document: null,
    });
    expect(
      pageRecord({ type: 'source', action: 'read', file: 'a.pdf', section: 'Leave', page: 3, path: '/x' }, null, NOW),
    ).toEqual({
      v: 1,
      type: 'source',
      time: NOW.toISOString(),
      library: null,
      action: 'read',
      file: 'a.pdf',
      section: 'Leave',
      page: 3,
    });
  });

  it('refuses anything else a page sends', () => {
    for (const bad of [
      null,
      'browse',
      { type: 'question', question: 'x' },
      { type: 'browse', page: 'settings' },
      { type: 'source', action: 'delete', file: 'a.pdf' },
      { type: 'source', action: 'open', file: '' },
    ])
      expect(pageRecord(bad, null, NOW)).toBeNull();
    expect(pageRecord({ type: 'source', action: 'open', file: 'a.pdf', page: -1 }, null, NOW)).toMatchObject({
      page: null,
    });
  });
});

describe('the record file', () => {
  it('appends one JSON line per event and counts them', () => {
    const r = new TestRecord(tmp(), { now: () => NOW });
    expect(r.status()).toMatchObject({ events: 0, questions: 0, paused: false, noticeShown: false });
    expect(r.append(questionRecord(run(), 'Work', NOW))).toBe(true);
    expect(r.append(pageRecord({ type: 'browse', page: 'library' }, 'Work', NOW)!)).toBe(true);
    const raw = fs.readFileSync(r.file, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[1]!)).toMatchObject({ type: 'browse', page: 'library' });
    expect(r.status()).toMatchObject({ events: 2, questions: 1 });
  });

  it('records nothing while paused, and the pause and the notice survive a restart', () => {
    const dir = tmp();
    const r = new TestRecord(dir);
    r.setPaused(true);
    r.noticeShown();
    expect(r.append(questionRecord(run(), null, NOW))).toBe(false);
    expect(fs.existsSync(r.file)).toBe(false);
    const again = new TestRecord(dir);
    expect(again.status()).toMatchObject({ paused: true, noticeShown: true, events: 0 });
    again.setPaused(false);
    expect(again.append(questionRecord(run(), null, NOW))).toBe(true);
    expect(again.status()).toMatchObject({ paused: false, events: 1 });
  });

  it('clears every line and keeps the settings', () => {
    const r = new TestRecord(tmp());
    r.noticeShown();
    r.append(questionRecord(run(), null, NOW));
    expect(r.clear()).toMatchObject({ events: 0, noticeShown: true });
    expect(fs.existsSync(r.file)).toBe(false);
    r.append(questionRecord(run(), null, NOW));
    expect(r.status().events).toBe(1);
  });

  it('skips a damaged line', () => {
    const r = new TestRecord(tmp());
    r.append(questionRecord(run(), null, NOW));
    fs.appendFileSync(r.file, '{"type":"browse","pa');
    expect(readRecord(r.file)).toHaveLength(1);
  });
});

describe('export', () => {
  function filled() {
    const r = new TestRecord(tmp(), { now: () => new Date(2026, 10, 7, 9, 5, 7) });
    r.append(questionRecord(run(), 'Work', NOW));
    r.append(pageRecord({ type: 'browse', page: 'document', document: 'Handbook' }, 'Work', NOW)!);
    r.append(pageRecord({ type: 'source', action: 'open', file: 'a.pdf', section: 'Leave', page: 2 }, 'Work', NOW)!);
    r.append({ v: 1, type: 'add', time: NOW.toISOString(), library: 'Work', kind: 'folder', added: 1, skipped: 0 });
    return r;
  }
  const lines = (file: string) =>
    fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('writes questions with answers and sources: every line as recorded, after a header', () => {
    const r = filled();
    const out = tmp();
    const file = r.export('full', out, { version: '0.1.0', platform: 'darwin' });
    expect(path.basename(file)).toBe('AskFiles test record with answers 2026-11-07 090507.jsonl');
    const [header, ...rest] = lines(file);
    expect(header).toEqual({
      v: 1,
      type: 'export',
      mode: 'full',
      exportedAt: new Date(2026, 10, 7, 9, 5, 7).toISOString(),
      app: '0.1.0',
      platform: 'darwin',
      lines: 4,
    });
    expect(rest).toEqual(readRecord(r.file));
  });

  it('writes questions only: no answer, cited sources, error text or document and file names', () => {
    const r = filled();
    const file = r.export('questions', tmp(), { version: '0.1.0', platform: 'win32' });
    expect(path.basename(file)).toBe('AskFiles test record questions only 2026-11-07 090507.jsonl');
    const [header, q, browse, source, add] = lines(file);
    expect(header).toMatchObject({ mode: 'questions', platform: 'win32', lines: 4 });
    expect(q).toMatchObject({
      question: 'What does the plan in the guidance say?',
      outcome: 'answer',
      starred: 1,
      totalMs: 5123,
      answer: null,
      cited: [],
      error: null,
    });
    expect((q!.switches as QuestionRecord['switches']).questionRewrite.fired).toBe(true);
    expect(browse).toMatchObject({ page: 'document', document: null });
    expect(source).toMatchObject({ action: 'open', file: '', section: null, page: null });
    expect(add).toMatchObject({ kind: 'folder', added: 1 });
    expect(JSON.stringify([q, browse, source])).not.toMatch(/plan names|Handbook|a\.pdf|Leave/);
  });

  it('never overwrites an earlier export', () => {
    const r = filled();
    const out = tmp();
    const a = r.export('full', out, { version: '0.1.0', platform: 'darwin' });
    const b = r.export('full', out, { version: '0.1.0', platform: 'darwin' });
    expect(path.basename(b)).toBe('AskFiles test record with answers 2026-11-07 090507 (2).jsonl');
    expect(a).not.toBe(b);
  });

  it('exports an empty record as the header alone', () => {
    const r = new TestRecord(tmp());
    const [header, ...rest] = lines(r.export('questions', tmp(), { version: '0.1.0', platform: 'darwin' }));
    expect(header).toMatchObject({ lines: 0 });
    expect(rest).toEqual([]);
  });

  it('leaves other lines as they are in questions mode', () => {
    const add = { v: 1, type: 'add', time: 't', library: null, kind: 'files', added: 2, skipped: 1 } as const;
    expect(exportLine(add, 'questions')).toEqual(add);
  });
});
