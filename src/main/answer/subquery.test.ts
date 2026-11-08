import { afterEach, describe, expect, it } from 'vitest';
import { buildIdentities, namedFileGroups } from '../browse/identifiers.js';
import { createSourceResolver } from '../watcher/index.js';
import { fixtureLibrary } from './__fixtures__/library.js';
import {
  DEFAULT_PARAMS,
  FILE_SCOPED_VECTOR_POOL,
  NO_RERANKER,
  retrieve,
  type PipelineDeps,
  type RunSettings,
} from './index.js';
import { clausesOf, fileSubqueries } from './subquery.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const doc = (id: string, title: string) => ({ id, title, relPath: title, outline: [] }) as never;
const ids = buildIdentities([
  doc('r', '01_Maintenance_Regulations_2025.pdf'),
  doc('e', '05_Inspecting_Labs_and_Workshops.pdf'),
  doc('s', '06_Maintenance_Strategy_Guidance.pdf'),
  doc('c', '08_Building_Management_Guidance.pdf'),
  doc('t', '10_Maintenance_Plan_Template.docx'),
  doc('a', '01_标准办公用品招标文件_2017年版.pdf'),
  doc('b', '02_标准印刷服务招标文件_2017年版.pdf'),
]);
const subs = (q: string) =>
  Object.fromEntries(
    fileSubqueries(q, namedFileGroups(q, ids), ids).map((x) => [x.documentId, x.attributed ? x.query : '*']),
  );

const CROSS_QUESTION =
  'Compare `01_Maintenance_Regulations_2025.pdf` and `05_Inspecting_Labs_and_Workshops.pdf`. What information about Fixed Criteria should be included in maintenance planning under the Regulations, and how does the evaluation example show those criteria being converted into an General Technical Score?';

describe('clausesOf', () => {
  it('splits sentences, not at the dot of a file name, and clauses at a comma before and', () => {
    expect(clausesOf(CROSS_QUESTION)).toEqual([
      'Compare `01_Maintenance_Regulations_2025.pdf` and `05_Inspecting_Labs_and_Workshops.pdf`.',
      'What information about Fixed Criteria should be included in maintenance planning under the Regulations',
      'and how does the evaluation example show those criteria being converted into an General Technical Score?',
    ]);
  });

  it('keeps a comma inside a list and splits Chinese at full-width marks', () => {
    expect(clausesOf('List the costs, risks and dates.')).toEqual(['List the costs, risks and dates.']);
    expect(clausesOf('对比《甲》和《乙》：最迟时间是什么？多久内答复，如何处理？')).toEqual([
      '对比《甲》和《乙》',
      '最迟时间是什么？',
      '多久内答复',
      '如何处理？',
    ]);
  });
});

describe('fileSubqueries', () => {
  it('gives a file the clause that names it alone, the whole question to a file with none', () => {
    expect(subs(CROSS_QUESTION)).toEqual({
      r: 'What information about Fixed Criteria should be included in maintenance planning under the Regulations',
      e: '*',
    });
  });

  it('joins several clauses of one file and leaves the lead-in naming both to neither', () => {
    const q =
      'Compare the Strategy Guidance and the Building Management Guidance. What do objectives do in the Strategy Guidance? Which KPIs does the Building Management Guidance require; how are they measured in the Strategy Guidance?';
    expect(subs(q)).toEqual({
      s: 'What do objectives do in the Strategy Guidance? how are they measured in the Strategy Guidance?',
      c: 'Which KPIs does the Building Management Guidance require',
    });
  });

  it('leaves both files on the whole question when only the lead-in names them', () => {
    expect(
      subs('对比《标准办公用品招标文件》和《标准印刷服务招标文件》：异议的最迟时间是什么？两份范本的要求是否一致？'),
    ).toEqual({ a: '*', b: '*' });
  });
});

describe('perFileSubquery in retrieval', () => {
  function setup(queries: string[]) {
    const lib = fixtureLibrary([
      {
        name: 'Maintenance_Regulations.pdf',
        sections: [
          { title: 'Signing', parts: ['The contract is signed by the Employer.'] },
          { title: 'Maintenance Plan', parts: ['The Maintenance Plan sets out fixed criteria and weighting.'] },
        ],
      },
      {
        name: 'Building_Management_Guidance.pdf',
        sections: [
          { title: 'Signing', parts: ['Signing of the contract by both parties.'] },
          { title: 'KPIs', parts: ['Key performance indicators with their measurement.'] },
        ],
      },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    const all = lib.records.flatMap((r, f) => r.sections.map((x) => [f, x.location] as const));
    const deps: PipelineDeps = {
      // Ranks a chunk first when it shares a word with the query, so the query shows in the order.
      vectorSearch: async (q, topK) => {
        queries.push(q);
        const words = new Set(q.toLowerCase().match(/[a-z]+/g) ?? []);
        const share = (loc: string) =>
          (
            lib.chunkText
              .get(loc)!
              .toLowerCase()
              .match(/[a-z]+/g) ?? []
          ).filter((w) => w.length > 3 && words.has(w)).length;
        return [...all]
          .sort((a, b) => share(b[1]) - share(a[1]))
          .slice(0, topK)
          .map(([f, loc], i) => ({
            id: loc,
            text: lib.chunkText.get(loc)!,
            metadata: { url: lib.records[f]!.url, title: lib.records[f]!.name },
            score: 0.9 - i * 0.01,
          }));
      },
      resolveSources: (x) => resolver(x),
      index: lib.index,
      reranker: null,
      chat: async () => ({ promptTokens: 1, completionTokens: 1 }),
    };
    const id = (n: number) => lib.index.getDocument({ url: lib.records[n]!.url, title: lib.records[n]!.name })!.id;
    return { deps, ids: [id(0), id(1)] };
  }
  const settings = (o: Partial<typeof DEFAULT_PARAMS>): RunSettings =>
    ({
      params: { ...DEFAULT_PARAMS, rerankerModel: NO_RERANKER, crossDocQuota: true, scopedQuotaV2: true, ...o },
      scope: 'balanced',
      chunkMaxChars: 2000,
      contextLength: 8192,
      chatModel: 'm',
      temperature: 0.1,
    }) as RunSettings;
  const q =
    'Compare the Maintenance Regulations and the Building Management Guidance on signing. What fixed criteria and weighting go into the plan under the Maintenance Regulations?';

  it('searches each file with its own clause, the whole question for a file without one', async () => {
    const queries: string[] = [];
    const { deps, ids } = setup(queries);
    const r = await retrieve(q, settings({ perFileSubquery: true }), deps);
    const clause = 'What fixed criteria and weighting go into the plan under the Maintenance Regulations?';
    expect(r.crossDocument!.subqueries).toEqual([
      { documentId: ids[0], query: clause, attributed: true },
      { documentId: ids[1], query: q, attributed: false },
    ]);
    // The library-wide search, then one wide search per distinct query.
    expect(queries).toEqual([q, clause, q]);
    // The Regulations' quota starts with the section its clause asks about.
    expect(r.crossDocument!.quota[0]).toBe(`${ids[0]}#2`);
  });

  it('is the whole question for every file when off', async () => {
    const queries: string[] = [];
    const { deps } = setup(queries);
    const r = await retrieve(q, settings({}), deps);
    expect(r.crossDocument!.subqueries).toBeUndefined();
    expect(queries).toEqual([q, q]);
    expect(FILE_SCOPED_VECTOR_POOL).toBe(2000);
  });
});
