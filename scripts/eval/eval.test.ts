import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countWords, sectionDocuments, slugify, splitKeyOf } from '../../src/main/sections/index.js';
import { formatComparison, markdownTable, summarize } from './aggregate.js';
import { resolveConfig, THRESHOLDS } from './config.js';
import { csvLine, parseCsv, parseRecords, toCsv } from './csv.js';
import { diffDocuments, prepareLibrary, workspaceNameFor, type LibraryClient } from './library.js';
import { fileHit, median, normalizeName, pageHit, sectionHit, sectionRecall, type SourceRecord } from './metrics.js';
import { listOf, loadQuestions, pagesOf, parseQuestions, CATEGORIES } from './questions.js';
import { applyScores, parseResults, RESULT_COLUMNS, type ResultRow } from './results.js';
import { resolveFallback, resultRow } from './run.js';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

describe('csv', () => {
  it('parses quotes, commas, line breaks, CRLF and a byte order mark', () => {
    const text = '\ufeffa,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,,3';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '', '3'],
    ]);
  });

  it('round-trips what it writes', () => {
    const records = [{ id: 'q1', text: 'a, "b"\n上海', n: 3, empty: null }];
    const csv = toCsv(['id', 'text', 'n', 'empty'], records);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(parseRecords(csv).records).toEqual([{ id: 'q1', text: 'a, "b"\n上海', n: '3', empty: '' }]);
  });

  it('lower-cases and trims header names', () => {
    expect(parseRecords(' ID ,Score\nq1,correct').records).toEqual([{ id: 'q1', score: 'correct' }]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b')).toThrow(/quoted field/);
  });

  it('quotes leading spaces so they survive', () => {
    expect(csvLine([' x', 'y'])).toBe('" x",y\r\n');
  });
});

describe('questions', () => {
  it('loads both fixture question sets, covering every category in corpus S', () => {
    const s = loadQuestions(path.join(FIXTURES, 'eval-s', 'questions.csv'));
    const l = loadQuestions(path.join(FIXTURES, 'eval-l', 'questions.csv'));
    expect(new Set(s.map((q) => q.category))).toEqual(new Set(CATEGORIES));
    expect(l.map((q) => q.category)).toContain('middle_of_long_doc');
    expect(l.map((q) => q.category)).toContain('section_listing');
  });

  it('lists every problem at once', () => {
    const csv = [
      'id,category,question,expected_section,expected_page',
      'q1,single_fact,What?,,3',
      'q1,guess,Why?,,x',
      'q3,section_listing,Which?,,',
    ].join('\n');
    const err = (() => {
      try {
        parseQuestions(csv);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain('line 3: duplicate id q1');
    expect(err).toContain('line 3: unknown category "guess"');
    expect(err).toContain('line 3: expected_page value "x"');
    expect(err).toContain('line 4: section_listing needs expected_section');
  });

  it('splits lists on ASCII and full-width semicolons and expands page ranges', () => {
    expect(listOf('a; b；c;;')).toEqual(['a', 'b', 'c']);
    expect(pagesOf('2;4-6')).toEqual([2, 4, 5, 6]);
  });
});

const src = (file: string, sectionTitle: string | null, page: number | null = null, pageEnd: number | null = null) =>
  ({ file, sectionTitle, sectionIndex: 1, page, pageEnd, score: 0.5, passage: '' }) as SourceRecord;

describe('citation metrics', () => {
  const q = {
    expected_source_file: '报销制度.docx;it-handbook.pdf',
    expected_section: '3 提交期限; 2.1 Lost devices',
    expected_page: '2',
  };

  it('needs every expected file and section', () => {
    const one = [src('报销制度.docx', '3 提交期限')];
    const both = [...one, src('it-handbook.pdf', '2.1  LOST devices', 1, 2)];
    expect(fileHit(q, one)).toBe(false);
    expect(fileHit(q, both)).toBe(true);
    expect(sectionHit(q, one)).toBe(false);
    expect(sectionRecall(q, one)).toBe(0.5);
    expect(sectionHit(q, both)).toBe(true);
  });

  it('checks pages against page ranges of sources from the expected files', () => {
    expect(pageHit(q, [src('it-handbook.pdf', null, 1, 2)])).toBe(true);
    expect(pageHit(q, [src('it-handbook.pdf', null, 3, 4)])).toBe(false);
    expect(pageHit(q, [src('other.pdf', null, 2, 2)])).toBe(false);
    expect(pageHit({ ...q, expected_page: '' }, [])).toBeNull();
  });

  it('returns null when nothing is expected', () => {
    const none = { expected_source_file: '', expected_section: '', expected_page: '' };
    expect([fileHit(none, []), sectionHit(none, []), pageHit(none, []), sectionRecall(none, [])]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('normalizes width, case, spacing and trailing punctuation', () => {
    expect(normalizeName('  Ａnnual   Leave： ')).toBe('annual leave');
  });

  it('computes medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([NaN])).toBeNull();
  });
});

describe('hashing and document names', () => {
  const chunk = {
    sectionTitle: 'Leave',
    sectionIndex: 2,
    sectionLevel: 1,
    subIndex: 1,
    subCount: 1,
    pageStart: 0,
    pageEnd: 0,
    text: 'Leave\n年假 25 days',
  };
  const file = { path: '/docs/报销 制度.docx', relPath: '报销 制度.docx', hash: 'abc' };
  const key = (o: Partial<Parameters<typeof splitKeyOf>[0]> = {}) =>
    splitKeyOf({ splitterVersion: 1, strategy: 'heading', maxChars: 2000, embeddingModel: 'bge-m3', ...o });

  it('changes the split key with chunk maximum, embedder and splitter version', () => {
    const base = key();
    expect(key()).toBe(base);
    expect(key({ maxChars: 1500 })).not.toBe(base);
    expect(key({ embeddingModel: 'qwen3-embedding:0.6b' })).not.toBe(base);
    expect(key({ splitterVersion: 2 })).not.toBe(base);
  });

  it('names documents deterministically from path, bytes, split key and position', () => {
    const [a] = sectionDocuments([chunk], file, { splitKey: key(), published: 'p' });
    const [b] = sectionDocuments([chunk], file, { splitKey: key(), published: 'other time' });
    const [c] = sectionDocuments([chunk], file, { splitKey: key({ maxChars: 1500 }), published: 'p' });
    const [d] = sectionDocuments([chunk], { ...file, hash: 'changed' }, { splitKey: key(), published: 'p' });
    expect(a!.name).toBe(b!.name);
    expect(a!.doc.id).toBe(b!.doc.id);
    expect(c!.name).not.toBe(a!.name);
    expect(d!.name).not.toBe(a!.name);
    expect(a!.name).toMatch(/^docx-[0-9a-f]{12}-2-1\.json$/);
    expect(a!.doc).toMatchObject({
      url: 'file:///docs/%E6%8A%A5%E9%94%80%20%E5%88%B6%E5%BA%A6.docx',
      title: '报销 制度.docx',
      sectionTitle: 'Leave',
      sectionIndex: 2,
      pageStart: 0,
      pageContent: chunk.text,
    });
  });

  it('gives every document the same keys with non-null values', () => {
    const docs = sectionDocuments([chunk, { ...chunk, sectionIndex: 3, pageStart: 4, pageEnd: 5 }], file, {
      splitKey: key(),
      published: 'p',
    });
    expect(Object.keys(docs[0]!.doc)).toEqual(Object.keys(docs[1]!.doc));
    for (const { doc } of docs) for (const v of Object.values(doc)) expect(v).not.toBeNull();
  });

  it('slugifies names and counts words and characters', () => {
    expect(slugify('Budget 2026 (final).xlsx')).toBe('Budget-2026-final-.xlsx');
    expect(slugify('报销制度.docx')).toBe('docx');
    expect(countWords('年假 25 days')).toBe(4);
  });
});

describe('config', () => {
  const base = { label: 'x', chatModel: 'm', embeddingModel: 'e', systemPrompt: 'p' };

  it('fills defaults and maps threshold names', () => {
    const c = resolveConfig({ ...base, similarityThreshold: 'High' }, '/cfg', '/repo');
    expect(c).toMatchObject({
      similarityThreshold: THRESHOLDS.high,
      topN: 4,
      chunkMax: 2000,
      passes: 2,
      dataDir: '/repo/.eval-data',
    });
  });

  it('lists every problem', () => {
    expect(() =>
      resolveConfig({ ...base, topN: 0, chatMode: 'agent', extra: 1, baseUrl: 'http://h' }, '/', '/'),
    ).toThrow(/unknown key extra[\s\S]*topN must be[\s\S]*chatMode must be[\s\S]*storageDir is required/);
  });

  it('loads the shipped configs', () => {
    for (const f of ['default.json', 'smoke.json']) {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'configs', f), 'utf8'));
      expect(() => resolveConfig(raw, __dirname, ROOT)).not.toThrow();
    }
  });
});

function row(p: Partial<ResultRow>): ResultRow {
  return {
    id: 'q',
    pass: 1,
    category: 'single_fact',
    expected_source_file: '',
    expected_section: '',
    expected_page: '',
    refused: false,
    sources: [],
    fallback: [],
    firstTokenMs: 1000,
    totalMs: 3000,
    error: '',
    score: null,
    ...p,
  };
}

describe('scores', () => {
  it('applies scores per id and pass, or per id for every pass', () => {
    const rows = [
      row({ id: 'a', pass: 1 }),
      row({ id: 'a', pass: 2 }),
      row({ id: 'b', pass: 1 }),
      row({ id: 'b', pass: 2 }),
    ];
    applyScores(rows, 'id,pass,score\na,1,correct\na,2,Wrong\n');
    expect(rows.map((r) => r.score)).toEqual(['correct', 'wrong', null, null]);
    const { unknownIds } = applyScores(rows, 'id,score\nb,partial\nz,correct\n');
    expect(rows.map((r) => r.score)).toEqual([null, null, 'partial', 'partial']);
    expect(unknownIds).toEqual(['z']);
  });

  it('rejects values outside the five scores', () => {
    expect(() => applyScores([row({})], 'id,score\nq,good\n')).toThrow(
      /correct, partial, wrong, refused, hallucinated/,
    );
  });

  it('reads back the rows run.ts writes', () => {
    const q = loadQuestions(path.join(FIXTURES, 'eval-s', 'questions.csv')).find((x) => x.id === 's09')!;
    const listed = [src('leave-policy-v1.md', 'Annual leave'), src('leave-policy-v2.md', 'Sick leave')];
    const r = resultRow({
      runId: 'r',
      corpus: 'S',
      pass: 2,
      q,
      outcome: {
        text: 'Nothing in your documents answers this question.',
        sources: [],
        firstTokenMs: 40,
        totalMs: 50,
        metrics: {},
        chatId: '',
        error: '',
      },
      fallback: listed,
    });
    expect(r).toMatchObject({ refused: 'yes', section_recall: '0.67', file_hit: 'no', pass: 2 });
    const csv = toCsv([...RESULT_COLUMNS], [r]);
    const [back] = parseResults(csv);
    expect(back).toMatchObject({ id: 's09', pass: 2, refused: true, fallback: listed, firstTokenMs: 40, totalMs: 50 });
  });
});

describe('aggregation', () => {
  const rows = [
    row({
      id: 'a',
      category: 'single_fact',
      score: 'correct',
      expected_source_file: 'x.pdf',
      sources: [src('x.pdf', 'S')],
      expected_section: 'S',
    }),
    row({
      id: 'a',
      pass: 2,
      category: 'single_fact',
      score: 'wrong',
      expected_source_file: 'x.pdf',
      sources: [src('y.pdf', 'S')],
      totalMs: 5000,
    }),
    row({ id: 'b', category: 'absent_unrelated', score: 'refused', refused: true, firstTokenMs: 10, totalMs: 10 }),
    row({ id: 'c', category: 'absent_related', score: 'hallucinated' }),
    row({ id: 'd', category: 'section_listing', expected_section: 'A;B', refused: true, fallback: [src('x', 'A')] }),
  ];

  it('summarizes rates, citations, recall and latency', () => {
    const s = summarize(rows);
    const single = s.categories.find((c) => c.category === 'single_fact')!;
    expect(single).toMatchObject({ rows: 2, scored: 2, autoRefused: 0 });
    expect(single.counts).toMatchObject({ correct: 1, wrong: 1 });
    expect(s.absentRefusal).toEqual({ hit: 1, n: 2 });
    expect(s.falseRefusal).toEqual({ hit: 0, n: 2 });
    expect(s.citation.file).toEqual({ hit: 1, n: 2 });
    expect(s.citationWhenCorrect.file).toEqual({ hit: 1, n: 1 });
    expect(s.sectionRecall).toEqual({ mean: 0.5, n: 1 });
    // Refused rows are left out of the latency medians.
    expect(s.latency).toEqual({ firstToken: 1000, total: 3000, n: 3 });
    expect(s.unscored).toBe(1);
  });

  it('prints a Markdown table row per run', () => {
    const table = markdownTable([{ corpus: 'S', label: 'start', chatModel: 'qwen3:8b', summary: summarize(rows) }]);
    expect(table.split('\n')).toEqual([
      '| Corpus | Config | Chat model | Single fact | Long doc | Cross doc | Table | Version | Absent related (refused) | Absent unrelated (refused) | Section recall | Citation file / section / page | Median first token / total (s) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| S | start | qwen3:8b | 50% (1/2) | - | - | - | - | 0% (0/1) | 100% (1/1) | 50% | 50% / 100% / - | 1.0 / 3.0 |',
    ]);
  });

  it('prints per-category deltas', () => {
    const better = rows.map((r) => (r.category === 'single_fact' ? { ...r, score: 'correct' as const } : r));
    const out = formatComparison({ title: 'A', summary: summarize(rows) }, { title: 'B', summary: summarize(better) });
    expect(out).toContain('| single_fact | 50% (1/2) | 100% (2/2) | +50 pp |');
  });
});

describe('fallback sources', () => {
  it('restores section keys that vector-search drops, matched on chunk text', () => {
    const index = new Map([
      [
        'Annual leave\nbody',
        { file: 'v1.md', sectionTitle: 'Annual leave', sectionIndex: 2, pageStart: 0, pageEnd: 0 },
      ],
    ]);
    const out = resolveFallback(
      [
        {
          text: '<document_metadata>\nsourceDocument: v1.md\n</document_metadata>\n\nAnnual leave\nbody',
          metadata: { title: 'v1.md' },
          score: 0.2,
        },
        { text: 'unknown', metadata: { title: 'z.md' }, score: 0.1 },
      ],
      index,
    );
    expect(out.map((s) => [s.file, s.sectionTitle, s.page])).toEqual([
      ['v1.md', 'Annual leave', null],
      ['z.md', null, null],
    ]);
  });
});

describe('library', () => {
  it('diffs workspace documents and names the workspace per embedder', () => {
    expect(diffDocuments(['a', 'b'], ['b', 'c'])).toEqual({ adds: ['c'], deletes: ['a'] });
    expect(workspaceNameFor({ workspace: 'w', embeddingModel: 'bge-m3' })).not.toBe(
      workspaceNameFor({ workspace: 'w', embeddingModel: 'all-minilm' }),
    );
  });

  it('embeds only new documents and re-embeds when the chunk maximum changes', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-eval-lib-'));
    const ws = new Set<string>();
    const calls: { adds?: string[]; deletes?: string[] }[] = [];
    const client: LibraryClient = {
      listWorkspaces: async () => (calls.length || ws.size ? [{ name: workspaceNameFor(cfg), slug: 'w' }] : []),
      createWorkspace: async () => ({ slug: 'w' }),
      updateWorkspace: async () => ({}),
      getWorkspace: async () => ({ documents: [...ws].map((docpath) => ({ docpath })) }),
      embedDocuments: async (_slug, body) => {
        calls.push(body);
        for (const d of body.adds ?? []) ws.add(d);
        for (const d of body.deletes ?? []) ws.delete(d);
        return {};
      },
      uploadDocument: async () => {
        throw new Error('no OCR expected');
      },
    };
    const cfg = resolveConfig(
      { label: 't', chatModel: 'm', embeddingModel: 'e', systemPrompt: 'p', chunkMax: 1500 },
      ROOT,
      ROOT,
    );
    const corpusDir = path.join(FIXTURES, 'eval-l', 'corpus');
    const opts = { client, removeDocuments: async () => {}, corpusDir, storageDir: storage, log: () => {} };
    const first = await prepareLibrary({ ...opts, config: cfg });
    expect(first.stats.added).toBe(first.stats.chunks);
    expect(first.files[0]!.splitSections).toBeGreaterThan(0);
    const again = await prepareLibrary({ ...opts, config: cfg });
    expect(again.stats).toMatchObject({ added: 0, reused: first.stats.chunks, removed: 0 });
    const wider = await prepareLibrary({ ...opts, config: { ...cfg, chunkMax: 2500 } });
    expect(wider.stats.added).toBe(wider.stats.chunks);
    expect(wider.stats.removed).toBe(first.stats.chunks);
    const stored = fs.readdirSync(path.join(storage, 'documents', 'askfiles-eval'));
    expect(stored).toHaveLength(first.stats.chunks + wider.stats.chunks);
    const doc = JSON.parse(fs.readFileSync(path.join(storage, 'documents', 'askfiles-eval', stored[0]!), 'utf8'));
    expect(doc.docSource).toBe('askfiles section split');
  });
});

describe('fixtures', () => {
  it('match what make-eval-fixtures.mjs generates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-eval-fx-'));
    const { writeFixtures } = await import('../../test/fixtures/make-eval-fixtures.mjs');
    writeFixtures(tmp);
    for (const sub of ['eval-s/corpus', 'eval-l/corpus']) {
      for (const f of fs.readdirSync(path.join(tmp, sub))) {
        expect(
          fs.readFileSync(path.join(tmp, sub, f)).equals(fs.readFileSync(path.join(FIXTURES, sub, f))),
          `${sub}/${f}`,
        ).toBe(true);
      }
    }
  });
});
