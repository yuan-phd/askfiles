import { afterEach, describe, expect, it } from 'vitest';
import { buildIdentities, namedFileGroups } from '../browse/identifiers.js';
import { createSourceResolver } from '../watcher/index.js';
import { fixtureLibrary } from './__fixtures__/library.js';
import {
  answer,
  choose,
  claimsOf,
  CROSS_DOCUMENT_QUOTA,
  CROSS_DOCUMENT_RULES,
  DEFAULT_PARAMS,
  FILE_SCOPED_VECTOR_POOL,
  SCOPED_V2_MAX_SECTIONS,
  SCOPED_V2_QUOTA,
  NAMED_FILE_QUOTA,
  NAMED_FILE_MAX_SECTIONS,
  takeInTurn,
  NO_RERANKER,
  parseCitations,
  quotaSections,
  retrieve,
  systemPrompt,
  userMessage,
  verifyClaims,
  type ChatFn,
  type PipelineDeps,
  type RunSettings,
} from './index.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const doc = (id: string, title: string) => ({ id, title, relPath: title, outline: [] }) as never;

describe('crossDocument detection', () => {
  const ids = buildIdentities([
    doc('a', '01_标准设备采购招标文件_2017年版.pdf'),
    doc('b', '02_标准材料采购招标文件_2017年版.pdf'),
    doc('c', '04_必须招标的工程项目规定.pdf'),
    doc('d', '07_必须招标的基础设施和公用事业项目范围规定.pdf'),
    doc('e', '13_必须招标的工程项目规定.docx'),
    doc('f', '01_Procurement_Regulations_2025.pdf'),
    doc('g', '08_Contract_Management_Guidance.pdf'),
  ]);
  const groups = (q: string) => namedFileGroups(q, ids).map((g) => g.map((f) => f.documentId).join('+'));

  it('names Chinese files by the title in their file name, without word boundaries', () => {
    expect(groups('对比《标准设备采购招标文件》和《标准材料采购招标文件》：异议的最迟时间是什么？')).toEqual([
      'a',
      'b',
    ]);
    // In the order the question names them.
    expect(groups('比较必须招标的基础设施和公用事业项目范围规定与01_标准设备采购招标文件_2017年版.pdf')).toEqual([
      'd',
      'a',
    ]);
  });

  it('counts a name two formats of one document share as one mention of both', () => {
    expect(groups('依照《必须招标的工程项目规定》，门槛是什么？')).toEqual(['c+e']);
    expect(groups('比较《必须招标的工程项目规定》和《必须招标的基础设施和公用事业项目范围规定》')).toEqual([
      'c+e',
      'd',
    ]);
    // Only file names share: the shared name is no identifier of one file (documentAffinity).
    expect(ids.find((f) => f.documentId === 'c')!.identifiers.map((i) => i.text)).not.toContain(
      '必须招标的工程项目规定',
    );
  });

  it('counts a file named twice once and leaves English names as before', () => {
    expect(
      groups(
        'Compare `01_Procurement_Regulations_2025.pdf` and the Contract Management Guidance with the Regulations.',
      ),
    ).toEqual(['f', 'g']);
    expect(groups('What do the Procurement Regulations say?')).toEqual(['f']);
  });
});

describe('crossDocument quota and prompt', () => {
  it('takes each named file top sections from the fused list in fused order', () => {
    const fused = ['x#1', 'a#4', 'b#2', 'a#1', 'a#7', 'a#9', 'x#2', 'b#5'].map((key) => ({ key }) as never);
    expect(quotaSections(fused, ['a', 'b'])).toEqual(['a#4', 'b#2', 'a#1', 'a#7', 'b#5']);
    expect(CROSS_DOCUMENT_QUOTA).toBe(3);
  });

  it('groups sources under their file and asks for one part per file, then the comparison', () => {
    const sources = [
      { path: ['A', 'Plan'], text: 'one', group: 'a.pdf' },
      { path: ['A', 'Plan 2'], text: 'two', group: 'a.pdf' },
      { path: ['B', 'When'], text: 'three', group: 'b.pdf' },
      { path: ['C', 'Other'], text: 'four', group: '' },
    ];
    expect(userMessage('Q?', sources, { grouped: true })).toBe(
      'Sources:\n\nSources from a.pdf:\n\n[1] A > Plan\none\n\n[2] A > Plan 2\ntwo\n\nSources from b.pdf:\n\n[3] B > When\nthree\n\nSources from other files:\n\n[4] C > Other\nfour\n\nQuestion: Q?',
    );
    const on = systemPrompt('default', { crossDocument: true, enumerate: true });
    for (const rule of CROSS_DOCUMENT_RULES) expect(on).toContain(rule);
    expect(on).not.toContain('Never write page numbers, file names or section names');
    expect(systemPrompt('default')).toContain('Never write page numbers, file names or section names');
  });

  it('verification keeps a sentence that names a file on that file sources', () => {
    const passages = [
      'The plan is completed when signing the contract.',
      'The plan is completed when signing the contract.',
    ];
    const claim = claimsOf(parseCitations('Under b.pdf the plan is completed when signing the contract [1].'), 2);
    expect(verifyClaims(claim, passages).claims[0]!.citations).toEqual([1]);
    expect(verifyClaims(claim, passages, { allowedFor: [new Set([2])] }).claims[0]!.citations).toEqual([2]);
  });
});

function settingsWith(p: Partial<typeof DEFAULT_PARAMS>): RunSettings {
  return {
    params: { ...structuredClone(DEFAULT_PARAMS), rerankerModel: NO_RERANKER, verifyCitations: true, ...p },
    scope: 'balanced',
    chatModel: 'test-model',
    contextLength: 8192,
    chunkMaxChars: 1000,
    temperature: 0.1,
  };
}

describe('crossDocument in the pipeline', () => {
  it('adds the named files quota, groups the prompt and verifies by the file a sentence names', async () => {
    const many = (w: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ title: `${w} ${i}`, parts: [`Contract plan rule ${w} ${i}.`] }));
    const lib = fixtureLibrary([
      { name: 'Other_Notes.pdf', sections: many('note', 8) },
      {
        name: 'Procurement_Regulations.pdf',
        sections: [{ title: 'Plan', parts: ['The contract plan is developed during contract creation.'] }],
      },
      {
        name: 'Contract_Management_Guidance.pdf',
        sections: [{ title: 'When to Plan', parts: ['The contract plan is completed when signing the contract.'] }],
      },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    const prompts: string[] = [];
    const reply =
      'Under the Procurement Regulations the contract plan is developed during contract creation [1].\n\n' +
      'Under the Contract Management Guidance the contract plan is completed when signing the contract [1].';
    const chat: ChatFn = async (o, onText) => {
      prompts.push(o.messages.map((m) => m.content).join('\n'));
      onText(reply);
      return { promptTokens: 10, completionTokens: 5 };
    };
    const logs: string[] = [];
    const deps: PipelineDeps = {
      // Vector search finds only the notes, so the named files come from the quota alone.
      vectorSearch: async () =>
        [...lib.chunkText.entries()]
          .filter(([, text]) => text.includes('note'))
          .map(([, text], i) => ({
            id: `v${i}`,
            text,
            metadata: { url: lib.records[0]!.url, title: lib.records[0]!.name },
            score: 0.9 - i * 0.01,
          })),
      resolveSources: (x) => resolver(x),
      index: lib.index,
      reranker: null,
      chat,
      log: (m) => logs.push(m),
    };
    // Vector search misses the two files; the keyword index finds them by creation and signing.
    const q =
      'Compare the Procurement Regulations and the Contract Management Guidance: is the plan made at creation or signing?';
    const on = settingsWith({ crossDocument: true });
    const r = await retrieve(q, on, deps);
    expect(r.crossDocument?.files).toEqual(['Procurement_Regulations.pdf', 'Contract_Management_Guidance.pdf']);
    const sel = choose(r, on);
    const files = sel.selected.map((x) => x.section.file);
    expect(files).toContain('Procurement_Regulations.pdf');
    expect(files).toContain('Contract_Management_Guidance.pdf');
    expect(sel.selected.length).toBeLessThanOrEqual(r.crossDocument!.quota.length + on.params.sectionCount.balanced);
    const result = await answer(q, r, sel, on, deps);
    // Grouped: the Regulations first as [1], the Guidance as [2], then the other files.
    expect(prompts[0]).toContain('Sources from Procurement_Regulations.pdf:\n\n[1] ');
    expect(prompts[0]).toContain('Sources from Contract_Management_Guidance.pdf:\n\n[2] ');
    expect(prompts[0]).toContain('Sources from other files:');
    // The second sentence cited [1] but names the Guidance, so it moves to [2].
    expect(result.claims.map((c) => c.citations)).toEqual([[1], [2]]);
    expect(logs).toContain('[answer] cross-document: 2 of 2 sentences name a file');

    // crossDocQuota: the same quota, the prompt and verification as without the switch.
    const quotaOnly = settingsWith({ crossDocQuota: true });
    const rq = await retrieve(q, quotaOnly, deps);
    expect(rq.crossDocument?.quota).toEqual(r.crossDocument!.quota);
    expect(choose(rq, quotaOnly).selected.map((x) => x.section.key)).toEqual(sel.selected.map((x) => x.section.key));
    prompts.length = 0;
    await answer(q, rq, choose(rq, quotaOnly), quotaOnly, deps);
    expect(prompts[0]).not.toContain('Sources from');
    expect(prompts[0]).toContain('Never write page numbers, file names or section names');

    // A question naming one file, or the switch off, is unchanged.
    const single = await retrieve('What do the Procurement Regulations say about the plan?', on, deps);
    expect(single.crossDocument).toBeUndefined();
    const off = settingsWith({});
    expect((await retrieve(q, off, deps)).crossDocument).toBeUndefined();
  });
});

describe('fileScopedQuota', () => {
  // 40 note sections fill the library-wide vector list (vectorTopK 30), so the named files'
  // sections are found only by a search inside each file.
  const notes = Array.from({ length: 40 }, (_, i) => ({ title: `Note ${i}`, parts: [`General remark ${i}.`] }));
  const regs = [
    { title: 'Scope', parts: ['Scope of these rules.'] },
    { title: 'Approval', parts: ['Approval of the contract plan by the board.'] },
    { title: 'Records', parts: ['Records are kept for seven years.'] },
    { title: 'Signing', parts: ['Signing of the contract plan by the director.'] },
  ];
  const guidance = [
    { title: 'Intro', parts: ['Introduction to the guidance.'] },
    { title: 'Timing', parts: ['The contract plan approval comes before signing.'] },
  ];
  function setup() {
    const lib = fixtureLibrary([
      { name: 'Other_Notes.pdf', sections: notes },
      { name: 'Procurement_Regulations.pdf', sections: regs },
      { name: 'Contract_Management_Guidance.pdf', sections: guidance },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    // Vector order: every note, then the Regulations as Records, Scope, Signing, Approval, then the Guidance.
    const order = [
      ...lib.records[0]!.sections.map((x) => [0, x.location] as const),
      ...[3, 1, 4, 2].map((i) => [1, lib.records[1]!.sections[i - 1]!.location] as const),
      ...lib.records[2]!.sections.map((x) => [2, x.location] as const),
    ];
    const topKs: number[] = [];
    const deps: PipelineDeps = {
      vectorSearch: async (_q, topK) => {
        topKs.push(topK);
        return order.slice(0, topK).map(([f, loc], i) => ({
          id: loc,
          text: lib.chunkText.get(loc)!,
          metadata: { url: lib.records[f]!.url, title: lib.records[f]!.name },
          score: 0.9 - i * 0.001,
        }));
      },
      resolveSources: (x) => resolver(x),
      index: lib.index,
      reranker: null,
      chat: async () => ({ promptTokens: 1, completionTokens: 1 }),
    };
    const docId = (n: number) => lib.index.getDocument({ url: lib.records[n]!.url, title: lib.records[n]!.name })!.id;
    return { deps, topKs, regs: docId(1), guidance: docId(2) };
  }
  const q = 'Compare the Procurement Regulations and the Contract Management Guidance on approval and signing.';

  it('takes each named file top 3 by vector and keyword search inside the file, fused by RRF', async () => {
    const { deps, topKs, regs, guidance } = setup();
    const s = settingsWith({ crossDocQuota: true, fileScopedQuota: true });
    const r = await retrieve(q, s, deps);
    expect(topKs).toEqual([s.params.vectorTopK, FILE_SCOPED_VECTOR_POOL]);
    // Approval and Signing are found by both searches inside the file, Records by vector rank 1 only;
    // Scope (vector rank 2 in the file, no keyword hit) is fourth.
    const quota = r.crossDocument!.quota;
    expect(quota.slice(0, 2).sort()).toEqual([`${regs}#2`, `${regs}#4`]);
    expect(quota[2]).toBe(`${regs}#3`);
    expect(quota.slice(3).sort()).toEqual([`${guidance}#1`, `${guidance}#2`]);
    // Records ranks below the library-wide vector list and holds no term, so only the scoped search finds it;
    // it still becomes a candidate and is selected.
    expect(r.candidates.map((c) => c.key)).toContain(`${regs}#3`);
    expect(choose(r, s).selected.map((x) => x.section.key)).toEqual(expect.arrayContaining(quota));

    // Off: the quota comes from the library-wide fused list, which never saw Records.
    const plain = await retrieve(q, settingsWith({ crossDocQuota: true }), deps);
    expect(plain.crossDocument!.quota).not.toContain(`${regs}#3`);
  });

  it('changes nothing for a question naming one file', async () => {
    const { deps, topKs } = setup();
    const s = settingsWith({ crossDocQuota: true, fileScopedQuota: true });
    const r = await retrieve('What do the Procurement Regulations say on signing?', s, deps);
    expect(r.crossDocument).toBeUndefined();
    expect(topKs).toEqual([s.params.vectorTopK]);
  });
});

describe('scopedQuotaV2', () => {
  // Two named files of seven sections each, one of them a table of contents that names every heading.
  const sections = (w: string) => [
    { title: 'Contents', parts: [`Approval ${w} 3\nSigning ${w} 4\nRecords ${w} 5`] },
    ...Array.from({ length: 6 }, (_, i) => ({ title: `Part ${i}`, parts: [`Approval and signing rule ${w} ${i}.`] })),
  ];
  function setup() {
    const lib = fixtureLibrary([
      { name: 'Procurement_Regulations.pdf', sections: sections('reg') },
      { name: 'Contract_Management_Guidance.pdf', sections: sections('guide') },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    // Vector search puts each file's contents first.
    const order = lib.records.flatMap((r, f) => r.sections.map((x) => [f, x.location] as const));
    const deps: PipelineDeps = {
      vectorSearch: async (_q, topK) =>
        order.slice(0, topK).map(([f, loc], i) => ({
          id: loc,
          text: lib.chunkText.get(loc)!,
          metadata: { url: lib.records[f]!.url, title: lib.records[f]!.name },
          score: 0.9 - i * 0.001,
        })),
      resolveSources: (x) => resolver(x),
      index: lib.index,
      reranker: null,
      chat: async () => ({ promptTokens: 1, completionTokens: 1 }),
    };
    const id = (n: number) => lib.index.getDocument({ url: lib.records[n]!.url, title: lib.records[n]!.name })!.id;
    return { deps, ids: [id(0), id(1)] };
  }
  const q = 'Compare the Procurement Regulations and the Contract Management Guidance on approval and signing.';

  it('leaves contents out inside the file, takes 5 per file and selects at most 8, the files in turn', async () => {
    const { deps, ids } = setup();
    const v1 = await retrieve(q, settingsWith({ crossDocQuota: true, fileScopedQuota: true }), deps);
    // C1 takes each file's contents into its quota.
    expect(v1.crossDocument!.quota).toContain(`${ids[0]}#1`);

    const s = settingsWith({ crossDocQuota: true, scopedQuotaV2: true });
    const r = await retrieve(q, s, deps);
    const quota = r.crossDocument!.quota;
    expect(quota).toHaveLength(2 * SCOPED_V2_QUOTA);
    expect(quota).not.toContain(`${ids[0]}#1`);
    expect(quota).not.toContain(`${ids[1]}#1`);
    const picked = choose(r, s).selected.map((x) => x.section.key);
    expect(picked).toHaveLength(SCOPED_V2_MAX_SECTIONS);
    // Four of each file, alternating.
    const docOf = (k: string) => k.slice(0, k.lastIndexOf('#'));
    expect(picked.map(docOf)).toEqual([0, 1, 0, 1, 0, 1, 0, 1].map((i) => ids[i]));
  });

  it('namedFileQuota8 takes 8 per file and selects at most 10, the files in turn', async () => {
    const lib = fixtureLibrary(
      ['Procurement_Regulations.pdf', 'Contract_Management_Guidance.pdf'].map((name, f) => ({
        name,
        sections: Array.from({ length: 12 }, (_, i) => ({
          title: `Part ${i}`,
          parts: [`Approval and signing rule ${f} ${i}.`],
        })),
      })),
    );
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    const order = lib.records.flatMap((r, f) => r.sections.map((x) => [f, x.location] as const));
    const deps: PipelineDeps = {
      vectorSearch: async (_q, topK) =>
        order.slice(0, topK).map(([f, loc], i) => ({
          id: loc,
          text: lib.chunkText.get(loc)!,
          metadata: { url: lib.records[f]!.url, title: lib.records[f]!.name },
          score: 0.9 - i * 0.001,
        })),
      resolveSources: (x) => resolver(x),
      index: lib.index,
      reranker: null,
      chat: async () => ({ promptTokens: 1, completionTokens: 1 }),
    };
    const id = (n: number) => lib.index.getDocument({ url: lib.records[n]!.url, title: lib.records[n]!.name })!.id;
    const s = settingsWith({ crossDocQuota: true, scopedQuotaV2: true, namedFileQuota8: true });
    const r = await retrieve(q, s, deps);
    expect(r.crossDocument!.quota).toHaveLength(2 * NAMED_FILE_QUOTA);
    const picked = choose(r, s).selected.map((x) => x.section.key);
    expect(picked).toHaveLength(NAMED_FILE_MAX_SECTIONS);
    const docOf = (k: string) => k.slice(0, k.lastIndexOf('#'));
    expect(picked.map(docOf)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1].map((i) => id(i)));
    // Without it the scopedQuotaV2 numbers hold.
    const v2 = settingsWith({ crossDocQuota: true, scopedQuotaV2: true });
    const r2 = await retrieve(q, v2, deps);
    expect(r2.crossDocument!.quota).toHaveLength(2 * SCOPED_V2_QUOTA);
    expect(choose(r2, v2).selected).toHaveLength(SCOPED_V2_MAX_SECTIONS);
  });

  it('takes the quota sections of several files in turn', () => {
    const x = (key: string) => ({ section: { key } });
    const own = ['a#2', 'b#1', 'a#5', 'a#7', 'b#3'].map(x);
    expect(takeInTurn(['a#5', 'a#2', 'a#7', 'b#3', 'b#1'], own).map((y) => y.section.key)).toEqual([
      'a#5',
      'b#3',
      'a#2',
      'b#1',
      'a#7',
    ]);
  });
});
