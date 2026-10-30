import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUESTION_COLUMNS as CASE_COLUMNS, appendEvalCase, type Retrieval } from '../../src/main/answer/index.js';
import {
  attributionOk,
  expectedSections,
  keyCoverage,
  metricsTable,
  summarizeMetrics,
  targetHit,
  type MetricQuestion,
} from './answer-metrics.js';
import { applySets, resolveConfig } from './config.js';
import { csvHeader, csvLine } from './csv.js';
import { answerMetrics, indexHash, sweep, sweepTable } from './pipeline.js';
import { loadQuestions, parseQuestions, type Question } from './questions.js';
import { RESULT_COLUMNS } from './results.js';
import { parseTry } from './run.js';
import { metricRowsOf } from './score.js';

const ROOT = path.resolve(__dirname, '../..');

const q = (over: Partial<MetricQuestion> = {}): MetricQuestion => ({
  category: 'single_fact',
  expected_source_file: 'handbook.pdf',
  expected_section: 'Annual leave',
  expected_section_path: '',
  key_elements: '27 days; paid',
  ...over,
});

const leave = { file: 'handbook.pdf', path: ['Handbook', 'Leave', 'Annual leave'], title: 'Annual leave' };

describe('answer metrics', () => {
  it('matches the expected section by title or by the end of its path, in the expected file', () => {
    expect(targetHit(q(), [leave])).toBe(true);
    expect(targetHit(q({ expected_section_path: 'Leave > Annual Leave' }), [leave])).toBe(true);
    expect(targetHit(q({ expected_section_path: 'Travel > Annual leave' }), [leave])).toBe(false);
    expect(targetHit(q(), [{ ...leave, file: 'other.pdf' }])).toBe(false);
    expect(targetHit(q({ category: 'absent_related' }), [leave])).toBeNull();
    expect(targetHit(q({ expected_section: '' }), [leave])).toBeNull();
  });

  it('pairs files with sections by position for cross-document questions', () => {
    const cross = q({ expected_source_file: 'a.pdf; b.docx', expected_section: 'One; Two' });
    expect(expectedSections(cross).map((e) => e.file)).toEqual(['a.pdf', 'b.docx']);
    const a = { file: 'a.pdf', path: ['One'], title: 'One' };
    const b = { file: 'b.docx', path: ['Two'], title: 'Two' };
    expect(targetHit(cross, [a])).toBe(false);
    expect(targetHit(cross, [b, a])).toBe(true);
  });

  it('measures key element coverage without regard to case and whitespace', () => {
    expect(keyCoverage(q(), 'You get 27  Days of PAID leave.')).toBe(1);
    expect(keyCoverage(q(), 'You get 27 days.')).toBe(0.5);
    expect(keyCoverage(q({ key_elements: '每晚650元' }), '上限是每晚 650 元。')).toBe(1);
    expect(keyCoverage(q({ key_elements: '' }), 'x')).toBeNull();
  });

  it('accepts attribution only when every cited section holds a key element, or a correct refusal', () => {
    const good = { passage: 'Employees get 27 days of leave.' };
    const bad = { passage: 'Parking is free.' };
    expect(attributionOk(q(), { refused: false, cited: [good] })).toBe(true);
    expect(attributionOk(q(), { refused: false, cited: [good, bad] })).toBe(false);
    expect(attributionOk(q(), { refused: false, cited: [] })).toBe(false);
    expect(attributionOk(q(), { refused: true, cited: [] })).toBe(false);
    expect(attributionOk(q({ category: 'absent_unrelated' }), { refused: true, cited: [] })).toBe(true);
    expect(attributionOk(q({ category: 'absent_unrelated' }), { refused: false, cited: [good] })).toBe(false);
  });

  it('summarizes per configuration and category with medians', () => {
    const rows = [
      {
        id: 'a',
        category: 'single_fact',
        config: 'c1',
        targetHit: true,
        keyCoverage: 1,
        attribution: true,
        firstTokenMs: 100,
        totalMs: 900,
      },
      {
        id: 'b',
        category: 'single_fact',
        config: 'c1',
        targetHit: false,
        keyCoverage: 0.5,
        attribution: false,
        firstTokenMs: 300,
        totalMs: 1100,
      },
      {
        id: 'c',
        category: 'absent_related',
        config: 'c1',
        targetHit: null,
        keyCoverage: null,
        attribution: true,
        firstTokenMs: null,
        totalMs: 500,
      },
    ];
    const all = summarizeMetrics(rows).find((s) => s.category === 'all')!;
    expect(all).toMatchObject({
      n: 3,
      targetHit: { hit: 1, n: 2 },
      keyCoverage: { mean: 0.75, n: 2 },
      attribution: { hit: 2, n: 3 },
      firstTokenMedianMs: 200,
      totalMedianMs: 900,
    });
    expect(metricsTable([all]).split('\n')[2]).toBe(
      '| c1 | all | 3 | 50% (1/2) | 75% (2) | 67% (2/3) | 200 ms | 900 ms |',
    );
  });
});

describe('questions with the new columns', () => {
  it('reads key_elements and expected_section_path, and the developer panel writes the same columns', () => {
    const qs = loadQuestions(path.join(ROOT, 'test', 'fixtures', 'eval-s', 'questions.csv'));
    expect(qs.every((x) => typeof x.key_elements === 'string')).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-q-'));
    const file = path.join(dir, 'q.csv');
    appendEvalCase(file, { question: 'Q?', file: 'a.pdf', path: ['A', 'B'], pageStart: 2 });
    const [saved] = parseQuestions(fs.readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({
      question: 'Q?',
      expected_section: 'B',
      expected_section_path: 'A > B',
      expected_page: '2',
    });
    expect([...CASE_COLUMNS].sort()).toEqual(
      [
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
      ].sort(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('config overrides', () => {
  const base = () =>
    resolveConfig({ label: 'x', chatModel: 'qwen3:8b', embeddingModel: 'bge-m3', systemPrompt: 'p' }, ROOT, ROOT);

  it('sets answer parameters by name and top-level keys, and checks both', () => {
    const c = applySets(base(), ['rerankFloor=0.35', 'sectionCount.balanced=4', 'temperature=0', 'scope=strict']);
    expect(c.answer.rerankFloor).toEqual({ strict: 0.35, balanced: 0.35, broad: 0.35 });
    expect(c.answer.sectionCount.balanced).toBe(4);
    expect(c.temperature).toBe(0);
    expect(c.scope).toBe('strict');
    expect(() => applySets(base(), ['scope=wide'])).toThrow(/scope must be one of/);
    expect(() => applySets(base(), ['temperature=hot'])).toThrow(/temperature must be a number/);
    expect(() => applySets(base(), ['nope=1'])).toThrow(/unknown parameter/);
  });

  it('merges a partial answer block over the defaults and reports bad keys', () => {
    const c = resolveConfig(
      { label: 'x', chatModel: 'm', embeddingModel: 'e', systemPrompt: 'p', answer: { rrfK: 10 } },
      ROOT,
      ROOT,
    );
    expect(c.answer.rrfK).toBe(10);
    expect(c.answer.vectorTopK).toBe(30);
    expect(c.rerankerDir).toBe(path.join(ROOT, '.eval-data', 'models', 'reranker'));
    expect(() =>
      resolveConfig(
        { label: 'x', chatModel: 'm', embeddingModel: 'e', systemPrompt: 'p', answer: { topK: 1 } },
        ROOT,
        ROOT,
      ),
    ).toThrow(/answer.topK is not a known field/);
  });

  it('parses --try specs', () => {
    expect(parseTry('count=3,floor=0.1')).toEqual({ count: 3, floor: 0.1 });
    expect(parseTry('floor=0')).toEqual({ floor: 0 });
    expect(() => parseTry('count=x')).toThrow(/expected count/);
  });
});

describe('stage 1 sweep', () => {
  const section = (title: string) => ({
    key: title,
    documentId: 'd',
    file: 'handbook.pdf',
    relPath: 'handbook.pdf',
    url: 'file:///handbook.pdf',
    sectionIndex: 1,
    title,
    path: [title],
    pageStart: 1,
    pageEnd: 1,
    pageLabel: null,
    text: 'short text',
    fullLength: 10,
  });
  const retrieval = (scores: [string, number][]): Retrieval => ({
    question: 'q',
    terms: [],
    vector: [],
    keyword: [],
    fused: [],
    candidates: scores.map(([t]) => section(t)),
    rerank: scores.map(([, s]) => s),
    bypass: false,
    bypassReason: null,
    timings: { vectorMs: 0, keywordMs: 0, rerankMs: 0 },
  });
  const question = (category: string, expected: string) => ({
    ...(q({ category: category as Question['category'], expected_section: expected }) as Question),
    id: 'x',
    question: 'q',
  });

  it('reports the hit rate for every section count and floor without the model', () => {
    const config = resolveConfig({ label: 'x', chatModel: 'm', embeddingModel: 'e', systemPrompt: 'p' }, ROOT, ROOT);
    const items = [
      {
        q: question('single_fact', 'B'),
        retrieval: retrieval([
          ['A', 0.9],
          ['B', 0.4],
        ]),
      },
      { q: question('single_fact', 'A'), retrieval: retrieval([['A', 0.08]]) },
      { q: question('absent_related', ''), retrieval: retrieval([['C', 0.02]]) },
      // A section listing is measured on the nearest list, which has no floor and no count.
      {
        q: question('section_listing', 'A; D'),
        retrieval: retrieval([
          ['A', 0.03],
          ['B', 0.02],
          ['D', 0.01],
        ]),
      },
    ];
    const cells = sweep(items, config, 1000, [1, 2], [0, 0.05, 0.5]);
    const at = (count: number, floor: number) => cells.find((c) => c.count === count && c.floor === floor)!;
    expect(at(1, 0)).toMatchObject({ hit: 2, n: 3, emptyAbsent: 0, nAbsent: 1 });
    expect(at(2, 0)).toMatchObject({ hit: 3, n: 3 });
    expect(at(2, 0.05)).toMatchObject({ hit: 3, emptyAbsent: 1 });
    expect(at(2, 0.5)).toMatchObject({ hit: 1, emptyAbsent: 1 });
    const table = sweepTable(cells, { count: 2, floor: 0.05 });
    expect(table.split('\n').slice(0, 4)).toEqual([
      '| Sections \\ floor | 0 | 0.05 | 0.5 |',
      '|---|---|---|---|',
      '| 1 | 67% | 67% | 33% |',
      '| 2 | 100% | **100%** | 33% |',
    ]);
  });

  it('keys the retrieval cache on the indexed chunks and the retrieval parameters only', () => {
    const config = resolveConfig({ label: 'x', chatModel: 'm', embeddingModel: 'e', systemPrompt: 'p' }, ROOT, ROOT);
    const lib = { records: [{ sections: [{ location: 'a' }, { location: 'b' }] }] } as never;
    const h = indexHash(config, lib);
    expect(indexHash({ ...config, temperature: 0.7 }, lib)).toBe(h);
    expect(indexHash(applySets(config, ['rerankFloor=0.9']), lib)).toBe(h);
    expect(indexHash(applySets(config, ['candidateSections=5']), lib)).not.toBe(h);
    expect(indexHash(config, { records: [{ sections: [{ location: 'a' }] }] } as never)).not.toBe(h);
  });
});

describe('section listing answers', () => {
  it('measures a no-answer state on the listed sections', () => {
    const listing = {
      ...(q({ category: 'section_listing', expected_section: 'A; B', key_elements: 'a; b' }) as Question),
      id: 'x',
      question: 'q',
    };
    const card = (title: string) => ({
      n: 1,
      file: 'handbook.pdf',
      relPath: 'handbook.pdf',
      url: 'u',
      documentId: 'd',
      sectionIndex: 1,
      title,
      path: [title],
      pageStart: null,
      pageEnd: null,
      pageLabel: null,
      passage: 'p',
      rerank: 0.01,
      trimmed: false,
    });
    const result = {
      text: 'NOT_IN_SOURCES',
      notFound: true,
      claims: [],
      cited: [],
      considered: [],
      nearest: [card('A'), card('C'), card('B')],
      skippedModel: true,
      timings: { firstTokenMs: null, modelMs: 0 },
      stats: { promptTokens: null, completionTokens: null },
    };
    expect(answerMetrics(listing, { result, error: '', totalMs: 10 })).toEqual({
      targetHit: true,
      keyCoverage: 1,
      attribution: true,
    });
    const missing = { ...result, nearest: [card('A')] };
    expect(answerMetrics(listing, { result: missing, error: '', totalMs: 10 })).toEqual({
      targetHit: false,
      keyCoverage: 0.5,
      attribution: false,
    });
  });
});

describe('score on upstream results', () => {
  it('computes the three metrics with the returned sources as the cited sections', () => {
    const row: Record<string, unknown> = {
      id: 's01',
      category: 'single_fact',
      expected_source_file: 'it-handbook.pdf',
      expected_section: '1 Accounts',
      key_elements: '90 days',
      answer: 'Every 90 days.',
      refused: 'no',
      first_token_ms: 100,
      total_ms: 800,
      sources_json: JSON.stringify([
        {
          file: 'it-handbook.pdf',
          sectionTitle: '1 Accounts',
          sectionIndex: 1,
          page: 1,
          pageEnd: 1,
          score: 0.5,
          passage: 'Change passwords every 90 days.',
        },
      ]),
    };
    const csv = csvHeader([...RESULT_COLUMNS]) + csvLine(RESULT_COLUMNS.map((c) => row[c]));
    expect(metricRowsOf(csv, 'upstream')).toEqual([
      {
        id: 's01',
        category: 'single_fact',
        config: 'upstream',
        targetHit: true,
        keyCoverage: 1,
        attribution: true,
        firstTokenMs: 100,
        totalMs: 800,
      },
    ]);
  });
});
