import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSourceResolver } from '../watcher/index.js';
import { fixtureLibrary } from './__fixtures__/library.js';
import {
  answer,
  choose,
  claimsOf,
  contentTokens,
  DEFAULT_PARAMS,
  NO_RERANKER,
  overlap,
  parseCitations,
  ParagraphStore,
  readVerdict,
  retrieve,
  selectParagraphs,
  splitParagraphs,
  systemPrompt,
  verifyClaims,
  withParagraphs,
  type AnswerEvent,
  type AnswerSection,
  type ChatFn,
  type PipelineDeps,
  type RunSettings,
} from './index.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('verifyCitations', () => {
  const passages = [
    'The Standstill Period shall last ten (10) Business Days after the notification of award.',
    'Bids are opened in public at the time and place stated in the bidding document.',
  ];
  const claims = (text: string) => claimsOf(parseCitations(text), passages.length);

  it('folds numbers and words and drops stopwords', () => {
    expect(contentTokens('The Standstill Period lasts 10 Business Days, 1,000 USD.')).toEqual([
      'standstill',
      'period',
      'lasts',
      '10',
      'business',
      'days',
      '1000',
      'usd',
    ]);
    expect(overlap(['a', 'b', 'b'], new Set(['a']))).toBe(0.5);
  });

  it('keeps a citation the sentence overlaps and moves a wrong one to the source that supports it', () => {
    const v = verifyClaims(
      claims('The standstill period lasts ten Business Days [1]. Bids are opened in public at the stated place [1].'),
      passages,
    );
    expect(v.claims.map((c) => c.citations)).toEqual([[1], [2]]);
    expect(v.stats).toEqual({ sentences: 2, reattributed: 1, attributed: 0, unsupported: 0 });
  });

  it('cites an uncited sentence one source supports and marks the rest unsupported without citations', () => {
    const v = verifyClaims(
      claims('Bids are opened in public. Late bids are rejected and returned unopened to the bidder [1].'),
      passages,
    );
    expect(v.claims.map((c) => [c.citations, c.unsupported])).toEqual([
      [[2], false],
      [[], true],
    ]);
    expect(v.stats).toMatchObject({ attributed: 1, unsupported: 1 });
  });

  it('in the pipeline shows only the sections still cited and logs the counts', async () => {
    const lib = fixtureLibrary([
      {
        name: 'handbook.pdf',
        sections: [
          { title: 'Annual leave', parts: ['Employees get 27 days of paid annual leave per year.'], page: 2 },
          { title: 'Travel', parts: ['Travel is booked through the portal by the employee.'], page: 7 },
        ],
      },
    ]);
    cleanups.push(lib.cleanup);
    const deps = depsOf(lib, ['Employees get 27 days of paid annual leave [2]. Pets are welcome [1].']);
    const logs: string[] = [];
    deps.log = (m) => logs.push(m);
    const s = settingsWith({ verifyCitations: true });
    const r = await retrieve('How many days of annual leave?', s, deps);
    const sel = choose(r, s);
    const leave = sel.selected.findIndex((x) => x.section.title === 'Annual leave') + 1;
    expect(leave).toBeGreaterThan(0);
    const result = await answer('How many days of annual leave?', r, sel, s, deps);
    expect(result.cited.map((c) => c.title)).toEqual(['Annual leave']);
    expect(result.claims.map((c) => [c.citations, c.unsupported])).toEqual([
      [[leave], false],
      [[], true],
    ]);
    expect(logs.some((l) => l.startsWith('[answer] verify: 2 sentences'))).toBe(true);
  });
});

describe('verdictLine', () => {
  it('reads FOUND and NOT_FOUND with formatting around them and waits while the line may grow', () => {
    expect(readVerdict('NOT_')).toMatchObject({ complete: false });
    expect(readVerdict('NOT F')).toMatchObject({ complete: false });
    expect(readVerdict('**FOUND**\nLeave is 27 days [1].')).toEqual({
      complete: true,
      verdict: 'found',
      rest: 'Leave is 27 days [1].',
    });
    expect(readVerdict('NOT_FOUND\nThe sources discuss travel.')).toMatchObject({ verdict: 'not_found' });
    expect(readVerdict('Leave is 27 days [1].')).toMatchObject({ complete: true, verdict: null });
    expect(systemPrompt('default', { verdictLine: true })).toContain('only FOUND or NOT_FOUND');
    expect(systemPrompt('default', { verdictLine: true })).not.toContain('NOT_IN_SOURCES');
    expect(systemPrompt('complete')).toContain("sources' own terms, names and numbers");
    expect(systemPrompt('default')).not.toContain('own terms');
  });

  function setup(reply: string[]) {
    const lib = fixtureLibrary([
      {
        name: 'handbook.pdf',
        sections: [{ title: 'Annual leave', parts: ['Employees get 27 days of paid annual leave per year.'] }],
      },
    ]);
    cleanups.push(lib.cleanup);
    return depsOf(lib, reply);
  }

  it('strips FOUND and answers as before', async () => {
    const deps = setup(['FOU', 'ND\nLeave is 27 days [', '1].']);
    const s = settingsWith({ verdictLine: true });
    const r = await retrieve('How many days of annual leave?', s, deps);
    const events: AnswerEvent[] = [];
    const result = await answer('q', r, choose(r, s), s, deps, (e) => events.push(e));
    expect(result).toMatchObject({ notFound: false, text: 'Leave is 27 days [1].' });
    expect(result.cited.map((c) => c.title)).toEqual(['Annual leave']);
    const shown = events.flatMap((e) => (e.type === 'delta' ? e.parts : []));
    expect(JSON.stringify(shown)).not.toContain('FOUND');
  });

  it('turns NOT_FOUND into the not-found state, shows nothing and keeps no checked sources', async () => {
    const deps = setup(['NOT_FOUND\nThe sources talk about leave [1].']);
    const s = settingsWith({ verdictLine: true });
    const r = await retrieve('How many days of sick leave?', s, deps);
    const events: AnswerEvent[] = [];
    const result = await answer('q', r, choose(r, s), s, deps, (e) => events.push(e));
    expect(result).toMatchObject({ notFound: true, cited: [], checked: [], claims: [] });
    expect(result.nearest.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'delta')).toBe(false);
  });
});

describe('paragraphSelection', () => {
  it('splits a section into paragraphs of about 200 to 500 characters', () => {
    const line = (i: number) => `Clause ${i}. ${'The supplier shall deliver the goods on time. '.repeat(3)}`.trim();
    const text = Array.from({ length: 12 }, (_, i) => line(i)).join('\n');
    const ps = splitParagraphs(text);
    expect(ps.length).toBeGreaterThan(3);
    expect(ps.every((p) => p.length <= 500)).toBe(true);
    expect(ps.slice(0, -1).every((p) => p.length >= 200)).toBe(true);
    expect(ps.join('\n')).toBe(text);
    // One long line with no breaks is cut at sentence ends.
    expect(splitParagraphs('A long sentence here. '.repeat(60)).every((p) => p.length <= 500)).toBe(true);
  });

  it('sends the paragraphs closest to the question with one neighbour each, in document order', () => {
    const paragraphs = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6 standstill', 'p7', 'p8'];
    const vectors = paragraphs.map((_, i) => new Float32Array(i === 2 ? [1, 0] : [0, 1]));
    const out = selectParagraphs({ paragraphs, vectors }, [1, 0], ['standstill'], 10_000);
    // Top 3: p2 by cosine, p6 by keyword plus nothing, then the first tie; neighbours of each.
    expect(out.startsWith('p0\n\np1\n\np2\n\np3')).toBe(true);
    expect(out).toContain('...\n\np5\n\np6 standstill\n\np7');
    expect(out.endsWith('\n\n...')).toBe(true);
    // A tight cap keeps the best paragraph first.
    expect(selectParagraphs({ paragraphs, vectors }, [1, 0], [], 4)).toBe('...\n\np2\n\n...');
  });

  it('stores paragraph vectors per document and replaces only long selected sections', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-paragraphs-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    let embedded = 0;
    const store = new ParagraphStore({
      dir,
      model: 'm',
      minSectionChars: 600,
      embed: async (texts) => {
        embedded += texts.length;
        return texts.map((t) => (t.includes('standstill') ? [1, 0] : [0, 1]));
      },
    });
    const long = Array.from({ length: 8 }, (_, i) =>
      i === 5 ? 'The standstill period is ten business days. '.repeat(6) : `Other clause ${i}. `.repeat(15),
    ).join('\n\n');
    const doc = {
      id: 'd1',
      title: 'rules.pdf',
      hash: 'h',
      splitKey: 'k',
      sections: [
        { index: 1, text: long },
        { index: 2, text: 'Short section.' },
      ],
    } as never;
    expect(await store.ensure(doc)).toBeGreaterThan(3);
    const before = embedded;
    expect(await store.ensure(doc)).toBe(0);
    expect(embedded).toBe(before);
    expect(store.get(doc, 2)).toBeNull();
    const sec = (index: number, text: string): AnswerSection =>
      ({ documentId: 'd1', sectionIndex: index, text, fullLength: text.length }) as AnswerSection;
    const out = await withParagraphs(
      'How long is the standstill period?',
      [sec(1, long.slice(0, 900)), sec(2, 'Short section.')],
      {
        source: store,
        document: () => doc,
        terms: [],
        minSectionChars: 600,
        cap: 4000,
      },
    );
    expect(out.replaced).toBe(1);
    expect(out.sections[0]!.text).toContain('The standstill period is ten business days.');
    expect(out.sections[1]!.text).toBe('Short section.');
  });
});

function settingsWith(p: Partial<typeof DEFAULT_PARAMS>): RunSettings {
  return {
    params: { ...structuredClone(DEFAULT_PARAMS), rerankerModel: NO_RERANKER, ...p },
    scope: 'balanced',
    chatModel: 'test-model',
    contextLength: 4096,
    chunkMaxChars: 1000,
    temperature: 0.1,
  };
}

function depsOf(lib: ReturnType<typeof fixtureLibrary>, reply: string[]): PipelineDeps {
  const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
  const chat: ChatFn = async (_o, onText) => {
    for (const piece of reply) onText(piece);
    return { promptTokens: 10, completionTokens: 5 };
  };
  return {
    vectorSearch: async () =>
      [...lib.chunkText.entries()].map(([, text], i) => ({
        id: `v${i}`,
        text,
        metadata: { url: lib.records[0]!.url, title: lib.records[0]!.name },
        score: 0.8 - i * 0.1,
      })),
    resolveSources: (x) => resolver(x),
    index: lib.index,
    reranker: null,
    chat,
  };
}
