import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIdentities, mentionedDocuments } from '../browse/identifiers.js';
import { createSourceResolver } from '../watcher/index.js';
import { fixtureLibrary } from './__fixtures__/library.js';
import {
  AFFINITY_MULTI_SECTIONS,
  answer,
  boostDocuments,
  choose,
  enumeratedItems,
  isSetQuestion,
  sourceHeader,
  statedCount,
  claimsOf,
  contentTokens,
  dropHedges,
  isHedge,
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

describe('documentAffinity', () => {
  const doc = (id: string, title: string, cover: string[] = []) =>
    ({
      id,
      title,
      relPath: title,
      outline: cover.map((c) => ({ title: c, level: 1, page: 1, sectionIndex: 1, pageLabel: null, children: [] })),
    }) as never;
  const library = [
    doc('a', '01_Procurement_Regulations_2025.pdf'),
    doc('b', '04_Procurement_Procedure_2026.pdf', ['Bank Procedure', 'Procurement in IPF and Other']),
    doc('c', '03_Procurement_Directive_2024.pdf', ['Bank Directive', 'Procurement in IPF and Other']),
    doc('d', '06_Procurement_Strategy_Guidance.pdf'),
    doc('e', '08_Contract_Management_Guidance.pdf'),
    doc('f', '10_Procurement_Plan_Template.docx'),
  ];
  const ids = buildIdentities(library);
  const named = (q: string) => mentionedDocuments(q, ids).map((f) => f.documentId);

  it('names a file by its name, cover line or a type word only it has, and drops shared names', () => {
    const b = ids.find((f) => f.documentId === 'b')!;
    expect(b.type).toBe('Procedure');
    expect(b.identifiers.map((i) => i.text)).toEqual(
      expect.arrayContaining(['Procurement Procedure 2026', 'Procurement Procedure', 'Bank Procedure', 'Procedure']),
    );
    expect(ids.flatMap((f) => f.identifiers.map((i) => i.text))).not.toContain('Procurement in IPF and Other');
    // Guidance is shared, so the word before it makes the name.
    expect(ids.find((f) => f.documentId === 'd')!.identifiers.map((i) => i.text)).toContain('Strategy Guidance');
    expect(ids.find((f) => f.documentId === 'd')!.identifiers.map((i) => i.text)).not.toContain('Guidance');
  });

  it('detects mentions, a bare type word only as a name', () => {
    expect(named('Under paragraph 5.79 of the September 2025 Procurement Regulations, what starts it?')).toEqual(['a']);
    expect(named('What is the effective date of the 2026 Bank Procedure?')).toEqual(['b']);
    expect(named('In RFP Model 2: Streamlined procedure, what starts the period?')).toEqual([]);
    expect(named('What does the Template say? And the Contract Management Guidance?')).toEqual(['e', 'f']);
    expect(named('In 10_Procurement_Plan_Template.docx, who cleared it?')).toEqual(['f']);
    expect(named('What is the US threshold under the Federal Acquisition Regulation?')).toEqual([]);
  });

  it('raises the named files in the fused order', () => {
    const f = (key: string, score: number) => ({ key, score }) as never;
    const out = boostDocuments([f('x#1', 2 / 61), f('a#3', 1 / 61), f('x#2', 1 / 62)], new Set(['a']));
    expect(out.map((s: { key: string }) => s.key)).toEqual(['x#1', 'a#3', 'x#2']);
    const strong = boostDocuments([f('x#1', 2 / 90), f('a#3', 1 / 61)], new Set(['a']));
    expect(strong.map((s: { key: string }) => s.key)).toEqual(['a#3', 'x#1']);
  });

  it('heads each source with file, type and path and flags same titles from different files', () => {
    const sources = [
      { path: ['Part II', 'Price Adjustment'], text: 'a', file: 'x.pdf', type: 'Guidance', title: 'Price Adjustment' },
      { path: ['Annex', 'Price Adjustment'], text: 'b', file: 'y.pdf', type: '', title: 'Price Adjustment' },
    ];
    expect(sourceHeader(sources, 0)).toBe(
      '[1] x.pdf | Guidance | Part II > Price Adjustment (same section title as [2], but from a different file)',
    );
    expect(sourceHeader(sources, 1)).toBe(
      '[2] y.pdf | Annex > Price Adjustment (same section title as [1], but from a different file)',
    );
  });

  it('verification keeps a named file only and chooses among same titles by overlap', () => {
    const passages = [
      'The price adjustment factor of 1.0 means no adjustment is made for the input.',
      'Price adjustment factor of 1.0 means no adjustment is made on account of the given input.',
    ];
    const meta = [
      { file: 'a.pdf', title: 'Price Adjustment' },
      { file: 'b.pdf', title: 'Price Adjustment' },
    ];
    const claim = claimsOf(parseCitations('A factor of 1.0 means no adjustment on account of the given input [1].'), 2);
    expect(verifyClaims(claim, passages).claims[0]!.citations).toEqual([1]);
    const v = verifyClaims(claim, passages, { meta });
    expect(v.claims[0]!.citations).toEqual([2]);
    expect(v.stats.reattributed).toBe(1);
    // Restricted to file a, the citation stays there although b overlaps more.
    expect(verifyClaims(claim, passages, { meta, allowed: new Set([1]) }).claims[0]!.citations).toEqual([1]);
    // An exact tie between same titles cites both.
    const tie = claimsOf(parseCitations('Factor 1.0 means no adjustment.'), 2);
    expect(verifyClaims(tie, passages, { meta }).claims[0]!.citations).toEqual([1, 2]);
  });

  it('in the pipeline boosts the named file and logs it', async () => {
    const lib = fixtureLibrary([
      { name: 'Leave_Policy.pdf', sections: [{ title: 'Annual leave', parts: ['Employees get 27 days of leave.'] }] },
      {
        name: 'Travel_Guidance.pdf',
        sections: [{ title: 'Annual leave', parts: ['Travel days are not leave days.'] }],
      },
    ]);
    cleanups.push(lib.cleanup);
    const deps = depsOf(lib, ['Employees get 27 days of leave [1].']);
    const logs: string[] = [];
    deps.log = (m) => logs.push(m);
    const s = settingsWith({ documentAffinity: true, verifyCitations: true });
    const r = await retrieve('How many days of annual leave does the Policy give?', s, deps);
    expect(r.affinity?.files).toEqual(['Leave_Policy.pdf']);
    expect(logs).toContain('[answer] affinity: Leave_Policy.pdf');
    let prompt = '';
    deps.chat = async (o, onText) => {
      prompt = o.messages[1]!.content;
      onText('Employees get 27 days of leave [1].');
      return { promptTokens: 1, completionTokens: 1 };
    };
    const result = await answer('q', r, choose(r, s), s, deps);
    expect(prompt).toContain('Leave_Policy.pdf | Policy | ');
    expect(result.cited.map((c) => c.file)).toEqual(['Leave_Policy.pdf']);
  });
});

describe('enumerateWhenAsked', () => {
  it('detects set questions and stated counts', () => {
    expect(isSetQuestion('What three activities help the Borrower focus?')).toBe(true);
    expect(statedCount('What three activities help the Borrower focus?')).toBe(3);
    expect(statedCount('what are the three weighted scores other than Sustainability')).toBe(3);
    expect(isSetQuestion('Which factors are considered when determining a rating?')).toBe(true);
    expect(statedCount('Which factors are considered?')).toBeNull();
    expect(isSetQuestion('Under paragraph 5.79 of the September 2025 Procurement Regulations, what starts it?')).toBe(
      false,
    );
    expect(statedCount('a weighting of 50% and a score of 2. What weighted score is displayed?')).toBe(null);
    expect(isSetQuestion('What is the effective date of the 2026 Bank Procedure?')).toBe(false);
    expect(isSetQuestion('采购计划需要哪些信息？')).toBe(true);
  });

  it('counts list lines, inline markers or cited sentences', () => {
    expect(enumeratedItems('Three steps:\n- one [1]\n- two [1]\n1. three [2]', 1)).toBe(3);
    expect(enumeratedItems('It does (a) this, (b) that and (c) more [1].', 1)).toBe(3);
    expect(enumeratedItems('One thing [1]. Another [2].', 2)).toBe(2);
  });

  function lib2() {
    const lib = fixtureLibrary([
      {
        name: 'guide.pdf',
        sections: [
          { title: 'Market research', parts: ['Three activities: market analysis, sounding and supply review.'] },
        ],
      },
    ]);
    cleanups.push(lib.cleanup);
    return lib;
  }

  it('adds the rule for set questions only, and a follow-up when items are missing', async () => {
    const lib = lib2();
    const calls: { system: string; n: number }[] = [];
    const deps = depsOf(lib, []);
    const replies = ['Market analysis is one [1].', 'Sounding and supply review are the others [1].'];
    deps.chat = async (o, onText) => {
      calls.push({ system: o.messages[0]!.content, n: o.messages.length });
      onText(replies[calls.length - 1]!);
      return { promptTokens: 1, completionTokens: 1 };
    };
    const logs: string[] = [];
    deps.log = (m) => logs.push(m);
    const s = settingsWith({ enumerateWhenAsked: true, enumerateFollowUp: true });
    const q = 'What three activities help with market research?';
    const r = await retrieve(q, s, deps);
    const result = await answer(q, r, choose(r, s), s, deps);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toContain('first count the items');
    expect(calls[1]!.n).toBe(4);
    expect(result.text).toBe('Market analysis is one [1].\n\nSounding and supply review are the others [1].');
    expect(result.followUp).toMatchObject({ wanted: 3, given: 1, added: true });
    expect(logs.some((l) => l.startsWith('[answer] enumerate: 1 of 3 items, completed by a follow-up'))).toBe(true);

    calls.length = 0;
    const q2 = 'How is market research done?';
    const r2 = await retrieve(q2, s, deps);
    await answer(q2, r2, choose(r2, s), s, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).not.toContain('first count the items');
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

describe('noSummarizing', () => {
  it('puts one rule on every question in place of the set rule', async () => {
    const { systemPrompt } = await import('./prompt.js');
    const { ENUMERATE_RULE, NO_SUMMARIZING_RULE } = await import('./enumerate.js');
    const on = systemPrompt('default', { enumerate: true, noSummarizing: true });
    expect(on).toContain(NO_SUMMARIZING_RULE);
    expect(on).not.toContain(ENUMERATE_RULE);
    expect(systemPrompt('default', { noSummarizing: true })).toContain(NO_SUMMARIZING_RULE);
    expect(systemPrompt('default', { enumerate: true })).toContain(ENUMERATE_RULE);
  });
});

describe('dropUnsupportedHedges', () => {
  const c = (text: string, citations: number[], unsupported = !citations.length) => ({ text, citations, unsupported });

  it('drops unsupported hedges only when a supported sentence stays', () => {
    const claims = [
      c('Leave is 27 days. ', [1]),
      c('The carry-over rule is not specified in the sources. ', []),
      c('Ask your manager. ', []),
      c('Sick leave is not stated separately. ', [2]),
    ];
    const d = dropHedges(claims);
    expect(d.dropped).toEqual(['The carry-over rule is not specified in the sources.']);
    expect(d.claims.map((x) => x.text.trim())).toEqual([
      'Leave is 27 days.',
      'Ask your manager.',
      'Sick leave is not stated separately.',
    ]);
    // Nothing supported: the answer would lose all it has, so nothing goes.
    expect(dropHedges([c('No information is provided. ', [])]).dropped).toEqual([]);
    expect(isHedge('The page number does not specify it.')).toBe(true);
    expect(isHedge('文件未说明页码。')).toBe(true);
    expect(isHedge('The Borrower specifies the date.')).toBe(false);
  });

  it('in the pipeline deletes the hedge after verification, logs it and returns the kept text', async () => {
    const lib = fixtureLibrary([
      { name: 'Leave_Policy.pdf', sections: [{ title: 'Annual leave', parts: ['Employees get 27 days of leave.'] }] },
    ]);
    cleanups.push(lib.cleanup);
    const deps = depsOf(lib, [
      'Employees get 27 days of leave [1]. The carry-over rule is not specified in the sources.',
    ]);
    const logs: string[] = [];
    deps.log = (m) => logs.push(m);
    const s = settingsWith({ verifyCitations: true, dropUnsupportedHedges: true });
    const r = await retrieve('How many days of annual leave?', s, deps);
    const result = await answer('q', r, choose(r, s), s, deps);
    expect(result.claims.map((x) => x.text.trim())).toEqual(['Employees get 27 days of leave .']);
    expect(result.text).toBe('Employees get 27 days of leave .[1]');
    expect(result.hedgesDropped).toEqual(['The carry-over rule is not specified in the sources.']);
    expect(logs).toContain('[answer] hedge dropped: The carry-over rule is not specified in the sources.');
  });
});

describe('documentAffinity with two or more files named', () => {
  it('selects AFFINITY_MULTI_SECTIONS sections instead of the scope count', async () => {
    // The test vector search maps every chunk to the first file, so it holds enough sections.
    const sections = (w: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ title: `Leave ${w} ${i}`, parts: [`Annual leave rule ${w} ${i}.`] }));
    const lib = fixtureLibrary([
      { name: 'Leave_Policy.pdf', sections: sections('p', 8) },
      { name: 'Travel_Guidance.pdf', sections: sections('g', 2) },
    ]);
    cleanups.push(lib.cleanup);
    const deps = depsOf(lib, ['x']);
    const q = 'What do the Policy and the Guidance say about annual leave?';
    const on = settingsWith({ documentAffinity: true });
    const r = await retrieve(q, on, deps);
    expect(r.affinity?.files).toHaveLength(2);
    expect(choose(r, on).selected).toHaveLength(AFFINITY_MULTI_SECTIONS);
    const off = settingsWith({});
    expect(choose(await retrieve(q, off, deps), off).selected).toHaveLength(off.params.sectionCount.balanced);
  });
});
