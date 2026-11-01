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
