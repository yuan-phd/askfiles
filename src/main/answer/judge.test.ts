import { afterEach, describe, expect, it } from 'vitest';
import { createSourceResolver } from '../watcher/index.js';
import { fixtureLibrary } from './__fixtures__/library.js';
import {
  choose,
  DEFAULT_PARAMS,
  JUDGE_MAX_TOKENS,
  JUDGE_SEED,
  JUDGE_SYSTEM,
  JUDGE_WINDOW,
  judgeFile,
  judgeMessages,
  judgeOrder,
  judgeText,
  NO_RERANKER,
  ollamaChat,
  parseJudgeScore,
  retrieve,
  SCOPED_V2_QUOTA,
  type ChatFn,
  type ChatOptions,
  type FusedSection,
  type PipelineDeps,
  type RunSettings,
} from './index.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('judge reply and order', () => {
  it('reads a single digit 0 to 3 and nothing else; anything else is missing, never 0', () => {
    expect(['3', ' 2\n', '0', '1'].map(parseJudgeScore)).toEqual([3, 2, 0, 1]);
    for (const bad of ['', '4', '2.', 'Score: 2', '23', 'two', '-1', '2 because'])
      expect(parseJudgeScore(bad)).toBeNull();
  });

  it('sorts by score descending, fused rank breaking ties', () => {
    expect(judgeOrder(['a', 'b', 'c', 'd', 'e'], [1, 3, 1, 3, 2])).toEqual(['b', 'd', 'e', 'a', 'c']);
    expect(judgeOrder(['a', 'b', 'c'], [2, 2, 2])).toEqual(['a', 'b', 'c']);
  });

  it('keeps a candidate with a missing score at its fused position, the scored ones sorted around it', () => {
    expect(judgeOrder(['a', 'b', 'c', 'd'], [1, null, 3, 2])).toEqual(['c', 'b', 'd', 'a']);
    expect(judgeOrder(['a', 'b', 'c'], [null, null, null])).toEqual(['a', 'b', 'c']);
    expect(judgeOrder(['a', 'b', 'c'], [null, 0, 3])).toEqual(['a', 'c', 'b']);
  });
});

describe('judge prompt and text', () => {
  it('asks with the question as asked, the heading path and the passage, question first', () => {
    const m = judgeMessages('When is the plan due?', ['IV', 'Plan'], 'Due at signing.');
    expect(m[0]).toEqual({ role: 'system', content: JUDGE_SYSTEM });
    expect(m[1]!.content).toBe(
      'Question: When is the plan due?\n\nSection: IV > Plan\n\nPassage:\nDue at signing.\n\nGrade (one digit, 0 to 3):',
    );
    expect(JUDGE_SYSTEM).toContain('one digit and nothing else');
  });

  it('sends the matched sub-chunks only, in document order, not the whole section', () => {
    const section = {
      parts: ['Alpha intro.', 'Beta holds the deadline rule.', 'Gamma other.', 'Delta signing.'],
      text: '',
    };
    // The vector hit is the chunk text (heading lines first); keyword term signing matches the fourth part.
    const f = { hitTexts: ['Plan\nBeta holds the deadline rule.'], terms: ['signing'] };
    expect(judgeText(section, f)).toBe('Beta holds the deadline rule.\n\nDelta signing.');
    // No match: the first part; no parts: the text.
    expect(judgeText(section, { hitTexts: [], terms: [] })).toBe('Alpha intro.');
    expect(judgeText({ parts: [], text: 'Whole.' }, { hitTexts: [], terms: [] })).toBe('Whole.');
  });
});

describe('judgeFile', () => {
  const fused = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `d#${i + 1}`, hitTexts: [], terms: [] }) as unknown as FusedSection);
  const section = (key: string) => ({
    section: { title: `S${key}`, path: ['Top', `S${key}`], parts: [`Text of ${key}.`], text: '' } as never,
  });

  it('scores the first JUDGE_WINDOW sections one call each, sequentially, temperature 0, seed 42, own options', async () => {
    const calls: ChatOptions[] = [];
    let open = 0;
    const replies: Record<string, string> = { 'd#3': '3', 'd#5': 'Score: 2', 'd#2': '1' };
    const chat: ChatFn = async (o, onText) => {
      expect(open).toBe(0);
      open++;
      calls.push(o);
      await new Promise((r) => setTimeout(r, 1));
      const key = /Text of (d#\d+)\./.exec(o.messages[1]!.content)![1]!;
      onText(replies[key] ?? '0');
      open--;
      return { promptTokens: 1, completionTokens: 1 };
    };
    const logs: string[] = [];
    const { ordered, record } = await judgeFile('Q?', 'd', 'clause', fused(JUDGE_WINDOW + 3), {
      chat,
      model: 'm',
      contextLength: 8192,
      section,
      log: (x) => logs.push(x),
    });
    expect(calls).toHaveLength(JUDGE_WINDOW);
    for (const c of calls) {
      expect(c).toMatchObject({
        model: 'm',
        temperature: 0,
        seed: JUDGE_SEED,
        maxTokens: JUDGE_MAX_TOKENS,
        contextLength: 8192,
      });
      expect(c.messages[1]!.content).toContain('Question: Q?');
    }
    // 3 first, then 1, then every 0 in fused order; d#5 has no score and keeps position 5.
    expect(ordered.slice(0, 6).map((f) => f.key)).toEqual(['d#3', 'd#2', 'd#1', 'd#4', 'd#5', 'd#6']);
    expect(ordered.slice(JUDGE_WINDOW).map((f) => f.key)).toEqual(['d#16', 'd#17', 'd#18']);
    const five = record.candidates.find((c) => c.key === 'd#5')!;
    expect(five).toMatchObject({ score: null, failure: 'Score: 2', fusedRank: 5, judgedRank: 5 });
    expect(record.candidates.find((c) => c.key === 'd#3')).toMatchObject({ score: 3, fusedRank: 3, judgedRank: 1 });
    expect(record.query).toBe('clause');
    expect(logs.some((l) => l.includes('no score for d#5'))).toBe(true);
    expect(logs.at(-1)).toContain('scores 3:1 2:0 1:1 0:12 missing:1');
  });

  it('records a failed call as missing and goes on', async () => {
    let n = 0;
    const chat: ChatFn = async (_o, onText) => {
      if (n++ === 0) throw new Error('boom');
      onText('2');
      return { promptTokens: 1, completionTokens: 1 };
    };
    const { record, ordered } = await judgeFile('Q?', 'd', 'Q?', fused(3), {
      chat,
      model: 'm',
      contextLength: 8192,
      section,
    });
    expect(record.candidates.map((c) => c.score)).toEqual([null, 2, 2]);
    expect(record.candidates[0]!.failure).toBe('error: boom');
    expect(ordered.map((f) => f.key)).toEqual(['d#1', 'd#2', 'd#3']);
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

describe('judgeRerank in the pipeline', () => {
  // Two named files of seven sections; in each the judge likes Part 5 best and Part 0 least.
  const sections = (w: string) =>
    Array.from({ length: 7 }, (_, i) => ({ title: `Part ${i}`, parts: [`Approval and signing rule ${w} ${i}.`] }));
  function setup(reply: (text: string) => string) {
    const lib = fixtureLibrary([
      { name: 'Maintenance_Regulations.pdf', sections: sections('reg') },
      { name: 'Building_Management_Guidance.pdf', sections: sections('guide') },
      { name: 'Other_Notes.pdf', sections: [{ title: 'Note', parts: ['General remark.'] }] },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    const order = lib.records.flatMap((r, f) => r.sections.map((x) => [f, x.location] as const));
    const queries: string[] = [];
    const judged: string[] = [];
    const deps: PipelineDeps = {
      vectorSearch: async (q, topK) => {
        queries.push(q);
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
      chat: async (o, onText) => {
        judged.push(o.messages[1]!.content);
        onText(reply(o.messages[1]!.content));
        return { promptTokens: 1, completionTokens: 1 };
      },
    };
    const id = (n: number) => lib.index.getDocument({ url: lib.records[n]!.url, title: lib.records[n]!.name })!.id;
    return { deps, ids: [id(0), id(1)], queries, judged };
  }
  const q =
    'Compare the Maintenance Regulations and the Building Management Guidance. When is approval due under the Regulations?';
  const likes = (t: string) => (/rule \w+ 5\./.test(t) ? '3' : /rule \w+ 0\./.test(t) ? '0' : '1');

  it('reorders each named file by the judge before its quota of 5, the clause list as candidates', async () => {
    const { deps, ids, queries, judged } = setup(likes);
    const s = settingsWith({ crossDocQuota: true, scopedQuotaV2: true, judgeRerank: true });
    const r = await retrieve(q, s, deps);
    // One call per candidate: each file has 7 sections, fewer than the window.
    expect(judged).toHaveLength(14);
    // The question as asked goes to the judge; the Regulations are searched with their own clause.
    expect(judged.every((t) => t.startsWith(`Question: ${q}\n`))).toBe(true);
    expect(queries).toContain('When is approval due under the Regulations?');
    const quota = r.crossDocument!.quota;
    expect(quota).toHaveLength(2 * SCOPED_V2_QUOTA);
    const docOf = (k: string) => k.slice(0, k.lastIndexOf('#'));
    for (const d of ids) {
      const mine = quota.filter((k) => docOf(k) === d);
      // Part 5 (section index 6) first, Part 0 (index 1) out of the five.
      expect(mine[0]).toBe(`${d}#6`);
      expect(mine).not.toContain(`${d}#1`);
    }
    const files = r.crossDocument!.judge!.files;
    expect(files.map((f) => f.documentId)).toEqual(ids);
    expect(files[0]!.query).toBe('When is approval due under the Regulations?');
    expect(files[1]!.query).toBe(q);
    expect(r.crossDocument!.judge!.ms).toBeGreaterThanOrEqual(0);
    // Selection after the quota is unchanged: 8 sections, the files in turn.
    expect(choose(r, s).selected.map((x) => docOf(x.section.key))).toEqual([0, 1, 0, 1, 0, 1, 0, 1].map((i) => ids[i]));
  });

  it('candidate source, both paths: a file with its own clause is searched with it, a file without one inside the file with the whole question', async () => {
    const { deps, ids, queries } = setup(likes);
    const s = settingsWith({ crossDocQuota: true, scopedQuotaV2: true, judgeRerank: true });
    const docOf = (k: string) => k.slice(0, k.lastIndexOf('#'));
    // Clause path for the Regulations, fallback for the Guidance.
    const mixed = (await retrieve(q, s, deps)).crossDocument!.judge!.files;
    expect(mixed.map((f) => f.query)).toEqual(['When is approval due under the Regulations?', q]);
    // No clause for either file: both fall back to the whole question.
    const plain = 'Compare the Maintenance Regulations and the Building Management Guidance on approval and signing.';
    const none = (await retrieve(plain, s, deps)).crossDocument!.judge!.files;
    expect(none.map((f) => f.query)).toEqual([plain, plain]);
    expect(queries).toContain(plain);
    // Either way the candidates come from the in-file list: only the file's own sections.
    for (const f of [...mixed, ...none]) {
      expect(f.candidates.length).toBeGreaterThan(0);
      expect(f.candidates.every((c) => docOf(c.key) === f.documentId)).toBe(true);
    }
    expect(none.map((f) => f.documentId)).toEqual(ids);
  });

  it('does not fire for a question naming one file, or with the switch off', async () => {
    const { deps, judged, queries } = setup(likes);
    const s = settingsWith({ crossDocQuota: true, scopedQuotaV2: true, judgeRerank: true });
    const one = await retrieve('When is approval due under the Maintenance Regulations?', s, deps);
    expect(one.crossDocument).toBeUndefined();
    const off = await retrieve(q, settingsWith({ crossDocQuota: true, scopedQuotaV2: true }), deps);
    expect(off.crossDocument!.judge).toBeUndefined();
    expect(judged).toHaveLength(0);
    // Off, perFileSubquery off: every file is searched with the whole question.
    expect(queries).not.toContain('When is approval due under the Regulations?');
  });

  it('keeps fused order when every reply is unparseable', async () => {
    const { deps } = setup(() => 'I think 3');
    const plain = await retrieve(
      q,
      settingsWith({ crossDocQuota: true, scopedQuotaV2: true, perFileSubquery: true }),
      deps,
    );
    const judged = await retrieve(
      q,
      settingsWith({ crossDocQuota: true, scopedQuotaV2: true, judgeRerank: true }),
      deps,
    );
    expect(judged.crossDocument!.quota).toEqual(plain.crossDocument!.quota);
    expect(judged.crossDocument!.judge!.files.flatMap((f) => f.candidates.map((c) => c.score))).toEqual(
      Array(14).fill(null),
    );
  });
});

describe('ollamaChat options for the judge', () => {
  it('sends seed and num_predict when given, and neither otherwise', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response('{"message":{"content":"2"},"done":true}\n', { status: 200 });
    }) as typeof fetch;
    const chat = ollamaChat(() => 'http://127.0.0.1:1', fetchImpl);
    const base = { model: 'm', messages: [], temperature: 0, contextLength: 8192 };
    await chat({ ...base, seed: 42, maxTokens: 8 }, () => {});
    await chat(base, () => {});
    expect(bodies[0]).toMatchObject({
      think: false,
      options: { temperature: 0, num_ctx: 8192, seed: 42, num_predict: 8 },
    });
    expect(bodies[1]!.options).toEqual({ temperature: 0, num_ctx: 8192 });
  });
});
