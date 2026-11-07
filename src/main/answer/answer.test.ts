import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSourceResolver } from '../watcher/index.js';
import { fixtureLibrary } from './__fixtures__/library.js';
import {
  appendEvalCase,
  applyOverrides,
  buildMessages,
  cardOf,
  choose,
  citationNumbers,
  CitationStream,
  claimsOf,
  contextBudget,
  cutSection,
  DEFAULT_PARAMS,
  ensureReranker,
  extractTerms,
  fuse,
  isMainlyCjk,
  isNotFound,
  NOT_FOUND_MARKER,
  parseCitations,
  rerankerProcess,
  resolveParams,
  retrieve,
  answer,
  rrf,
  sectionKey,
  sectionTokens,
  selectSections,
  ThinkFilter,
  toAnswerSection,
  userMessage,
  type AnswerEvent,
  type AnswerSection,
  type ChatFn,
  type PipelineDeps,
  type RawVectorHit,
  type Ranked,
  type Reranker,
  type RunSettings,
  type TermStats,
  NO_RERANKER,
  setFloor,
  assembleSection,
  isContentsSection,
  normalizeForMatch,
  parseExcerpts,
  verifyExcerpts,
} from './index.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Term stats over a list of texts, the way the browse index counts sections. */
function statsOf(texts: string[]): TermStats {
  const folded = texts.map((t) => t.normalize('NFKC').toLowerCase());
  return { total: texts.length, frequency: (term) => folded.filter((t) => t.includes(term)).length };
}

describe('extractTerms', () => {
  const corpus = statsOf([
    'Task teams meet weekly. The task team lead writes the notes.',
    'Annual leave is 27 days per year for every employee.',
    'Use Microsoft Teams for calls. VPN access needs ticket IT-4521.',
    'Expense claims are due within 30 days.',
    'The employee handbook covers leave, travel and expenses for every employee.',
    'Travel must be booked through the portal by the employee.',
    'Passwords change every 90 days.',
    'The office opens at 9.',
  ]);

  it('finds codes, numbers, acronyms and capitalized names that occur in the index', () => {
    const terms = extractTerms('Who handles ticket IT-4521 for the VPN in Microsoft Teams?', corpus);
    const byText = Object.fromEntries(terms.map((t) => [t.text, t.kind]));
    expect(byText['it-4521']).toBe('code');
    expect(byText['vpn']).toBe('code');
    expect(byText['microsoft teams']).toBe('name');
  });

  it('keeps a lower-case word pair that is rare in the index (task teams)', () => {
    const terms = extractTerms('what do task teams do', corpus).map((t) => t.text);
    expect(terms).toContain('task teams');
  });

  it('keeps quoted phrases whatever their case', () => {
    const terms = extractTerms('Where does it say "Expense Claims"?', corpus);
    expect(terms).toContainEqual(expect.objectContaining({ text: 'expense claims', kind: 'quoted' }));
  });

  it('drops stop words, words in no section and words in too many sections', () => {
    const terms = extractTerms('What does the employee handbook say about the moon?', corpus).map((t) => t.text);
    expect(terms).not.toContain('what');
    expect(terms).not.toContain('moon');
    // employee is in 4 of 8 sections, above the rare share.
    expect(terms).not.toContain('employee');
    expect(terms).toContain('handbook');
  });

  it('takes rare Chinese n-grams, the longest that occur, without question words', () => {
    const zh = statsOf([
      '员工每年享有带薪年假二十七天。',
      '差旅报销需要在三十天内提交。',
      '上海的住宿报销上限是每晚650元。',
      '本制度适用于全体员工。',
      '员工请假需要提前申请。',
    ]);
    const terms = extractTerms('上海的住宿报销上限是多少？', zh);
    const texts = terms.map((t) => t.text);
    expect(terms.every((t) => t.kind === 'cjk')).toBe(true);
    expect(texts).toContain('住宿报销');
    expect(texts).not.toContain('多少');
    // A gram inside a longer kept one is dropped.
    expect(texts).not.toContain('住宿');
    expect(texts.every((t) => t.length >= 2 && t.length <= 4)).toBe(true);
  });

  it('tells mainly Chinese text apart', () => {
    expect(isMainlyCjk('上海的住宿报销上限是多少？')).toBe(true);
    expect(isMainlyCjk('How many days of leave? 年假')).toBe(false);
  });
});

describe('fuse', () => {
  it('scores a section by its best chunk and its keyword hit, with a capped bonus for more chunks', () => {
    const a = sectionKey('d1', 1);
    const b = sectionKey('d1', 2);
    const c = sectionKey('d2', 1);
    const fused = fuse(
      [
        { id: 'v1', text: 'x', score: 0.9, section: b },
        { id: 'v2', text: 'y', score: 0.8, section: a },
        { id: 'v3', text: 'z', score: 0.7, section: b },
        { id: 'v4', text: 'w', score: 0.6, section: null },
      ],
      [
        { section: c, score: 5, terms: ['task teams'] },
        { section: a, score: 2, terms: ['leave'] },
      ],
      60,
    );
    // a: found by both lists; b: two sub-chunks, the second worth at most 10 percent; c: keyword only.
    expect(fused.map((f) => f.key)).toEqual([a, b, c]);
    expect(fused[0]).toMatchObject({ vectorRank: 2, keywordRank: 2, terms: ['leave'] });
    expect(fused[0]!.score).toBeCloseTo(rrf(2, 60) + rrf(2, 60));
    expect(fused[1]!.score).toBeCloseTo(rrf(1, 60) * 1.1);
    expect(fused[1]!.extraVector).toBeCloseTo(rrf(3, 60));
    expect(fused[1]!.hitTexts).toEqual(['x', 'z']);
  });

  it('ranks the section first in both lists above a long one with several weaker hits', () => {
    const target = sectionKey('regs', 84);
    const long = sectionKey('rfb', 18);
    const vector = [
      { id: 't', text: 't', score: 0.8, section: target },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, text: `f${i}`, score: 0.7, section: `filler#${i}` })),
      ...[11, 12, 13].map((r) => ({ id: `l${r}`, text: `l${r}`, score: 0.6, section: long })),
    ];
    const fused = fuse(
      vector,
      [
        { section: target, score: 9, terms: ['5.79'] },
        ...Array.from({ length: 26 }, (_, i) => ({ section: `kw#${i}`, score: 1, terms: [] })),
        { section: long, score: 1, terms: [] },
      ],
      60,
    );
    expect(fused[0]!.key).toBe(target);
    const l = fused.find((f) => f.key === long)!;
    const base = rrf(11, 60) + rrf(28, 60);
    expect(l.score).toBeCloseTo(base * 1.1);
  });
});

describe('assembleSection', () => {
  const part = (n: number) => `Part ${n} body sentence number ${n}. `.repeat(8).trim();
  const parts = Array.from({ length: 10 }, (_, i) => part(i + 1));
  const len = parts[0]!.length;

  it('sends a section whole when it fits twice the chunk maximum', () => {
    const few = parts.slice(0, 3);
    expect(assembleSection(few, { cap: 10_000, wholeChars: 10_000 })).toBe(few.join('\n\n'));
  });

  it('takes matched parts with one neighbour each side, in document order, without repeats', () => {
    const out = assembleSection(parts, {
      cap: 10_000,
      wholeChars: len * 3,
      hitTexts: [`Heading\n${parts[6]}`],
      terms: ['part 2 body'],
    });
    expect(out).toBe([parts[0], parts[1], parts[2], '...', parts[5], parts[6], parts[7], '...'].join('\n\n'));
  });

  it('keeps matched parts before neighbours when the cap is tight, and the start without a match', () => {
    const out = assembleSection(parts, {
      cap: len * 2 + 20,
      wholeChars: 0,
      hitTexts: [parts[6]!],
      terms: ['part 2 body'],
    });
    expect(out).toContain(parts[6]);
    expect(out).toContain(parts[1]);
    expect(out).not.toContain(parts[5]);
    expect(assembleSection(parts, { cap: len + 10, wholeChars: 0 }).startsWith(parts[0]!.slice(0, 40))).toBe(true);
  });
});

describe('sections', () => {
  it('assembles a long section from its sub-chunks in document order and keeps the path', () => {
    const lib = fixtureLibrary([
      {
        name: 'handbook.md',
        sections: [
          { title: 'Leave', level: 1, parts: ['Leave rules.'] },
          { title: 'Annual leave', level: 2, parts: ['Part one about leave.', 'Part two with 27 days.'], page: 3 },
        ],
      },
    ]);
    cleanups.push(lib.cleanup);
    const doc = lib.index.listDocuments()[0]!;
    const found = lib.index.section(doc.id, 2)!;
    expect(found.section.text).toBe('Part one about leave.\n\nPart two with 27 days.');
    const s = cardOf(1, sectionOf(lib, 'handbook.md', 2), 0.9);
    expect(s).toMatchObject({ file: 'handbook.md', path: ['Leave', 'Annual leave'], pageStart: 3, pageEnd: 3 });
  });

  it('cuts a long section around the vector hit, marking the cut ends', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of the rules with enough words.`).join('\n');
    const cut = cutSection(text, 400, ['Heading\nParagraph 30 of the rules with enough words.']);
    expect(cut.length).toBeLessThanOrEqual(406);
    expect(cut).toContain('Paragraph 30 of the rules');
    expect(cut.startsWith('...')).toBe(true);
    expect(cutSection(text, 400).startsWith('Paragraph 0')).toBe(true);
    expect(cutSection('short', 400)).toBe('short');
  });
});

function section(key: string, text: string, pathParts = [key]): AnswerSection {
  return {
    key,
    documentId: 'd',
    file: `${key}.pdf`,
    relPath: `${key}.pdf`,
    url: `file:///${key}.pdf`,
    sectionIndex: 1,
    title: pathParts[pathParts.length - 1]!,
    path: pathParts,
    pageStart: 1,
    pageEnd: 1,
    pageLabel: null,
    text,
    fullLength: text.length,
  };
}

function sectionOf(lib: ReturnType<typeof fixtureLibrary>, file: string, index: number): AnswerSection {
  const doc = lib.index.listDocuments().find((d) => d.title === file)!;
  const { document, section: s } = lib.index.section(doc.id, index)!;
  return toAnswerSection(document, s, 100_000);
}

describe('selectSections', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const ranked: Ranked[] = [
    { section: section('a', words(300)), rerank: 0.95 },
    { section: section('b', words(300)), rerank: 0.6 },
    { section: section('c', words(300)), rerank: 0.3 },
    { section: section('d', words(300)), rerank: 0.08 },
    { section: section('e', words(300)), rerank: 0.02 },
    { section: section('f', words(300)), rerank: 0.001 },
  ];
  const run = (scope: 'strict' | 'balanced' | 'broad', budgetTokens = 100_000) =>
    selectSections(ranked, {
      count: DEFAULT_PARAMS.sectionCount[scope],
      floor: DEFAULT_PARAMS.rerankFloor[scope],
      budgetTokens,
      floorOn: 'rerank',
    });

  it('maps each scope to its count and floor', () => {
    expect(run('strict').selected.map((s) => s.section.key)).toEqual(['a', 'b']);
    expect(run('balanced').selected.map((s) => s.section.key)).toEqual(['a', 'b', 'c']);
    expect(run('broad').selected.map((s) => s.section.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(run('strict').dropped).toContainEqual({ key: 'c', reason: 'below-floor' });
    expect(run('balanced').dropped).toContainEqual({ key: 'd', reason: 'below-floor' });
    expect(run('broad').dropped).toContainEqual({ key: 'f', reason: 'below-floor' });
  });

  it('keeps sections whole when they fit and trims the longest one when they do not', () => {
    const one = sectionTokens(ranked[0]!.section);
    expect(run('balanced', one * 3).selected.every((s) => !s.trimmed)).toBe(true);
    const tight = run('balanced', one * 3 - 50);
    expect(tight.selected).toHaveLength(3);
    expect(tight.selected.filter((s) => s.trimmed)).toHaveLength(1);
    expect(tight.usedTokens).toBeLessThanOrEqual(one * 3 - 50);
  });

  it('drops the lowest-ranked section when trimming would leave too little', () => {
    const one = sectionTokens(ranked[0]!.section);
    const sel = run('balanced', one * 2 + 20);
    expect(sel.selected.map((s) => s.section.key)).toEqual(['a', 'b']);
    expect(sel.dropped).toContainEqual({ key: 'c', reason: 'over-budget' });
  });

  it('ignores the floor when reranking was bypassed', () => {
    const sel = selectSections(
      ranked.map((r) => ({ ...r, rerank: null })),
      { count: 3, floor: 0.5, budgetTokens: 100_000, floorOn: 'none' },
    );
    expect(sel.selected.map((s) => s.section.key)).toEqual(['a', 'b', 'c']);
  });

  it('applies the floor to vector similarity without a reranker; keyword-only sections pass only 0', () => {
    const vectors = [0.71, null, 0.55, 0.62, 0.4, 0.3];
    const byVector = ranked.map((r, i) => ({ ...r, rerank: null, vector: vectors[i] }));
    const pick = (floor: number) =>
      selectSections(byVector, { count: 3, floor, budgetTokens: 100_000, floorOn: 'vector' }).selected.map(
        (s) => s.section.key,
      );
    expect(pick(0.5)).toEqual(['a', 'c', 'd']);
    expect(pick(0.7)).toEqual(['a']);
    expect(pick(0)).toEqual(['a', 'b', 'c']);
  });

  it('derives the budget from the context length unless set', () => {
    expect(contextBudget(DEFAULT_PARAMS, 8192)).toBe(8192 - 1024 - 512);
    expect(contextBudget(DEFAULT_PARAMS, 1000)).toBe(600);
    expect(contextBudget({ ...DEFAULT_PARAMS, contextBudgetTokens: 1234 }, 8192)).toBe(1234);
  });
});

describe('prompt', () => {
  it('numbers the sources with their section path and never names a file or page', () => {
    const msgs = buildMessages(
      'How long is leave?',
      [section('a', 'Leave is 27 days.', ['Handbook', 'Leave'])],
      'default',
    );
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('[n]');
    expect(msgs[0]!.content).toContain(NOT_FOUND_MARKER);
    expect(msgs[1]!.content).toBe(
      'Sources:\n\n[1] Handbook > Leave\nLeave is 27 days.\n\nQuestion: How long is leave?',
    );
    expect(msgs[1]!.content).not.toContain('a.pdf');
    expect(buildMessages('q', [], 'strict')[0]!.content).toContain('Every sentence');
  });

  it('builds the user message for several sources in order', () => {
    expect(
      userMessage('q', [
        { path: ['A'], text: 'one' },
        { path: ['B', 'C'], text: 'two' },
      ]),
    ).toBe('Sources:\n\n[1] A\none\n\n[2] B > C\ntwo\n\nQuestion: q');
  });

  it('detects the not-found marker', () => {
    expect(isNotFound(NOT_FOUND_MARKER)).toBe(true);
    expect(isNotFound(`**${NOT_FOUND_MARKER}**`)).toBe(true);
    expect(isNotFound(`I could not find it. ${NOT_FOUND_MARKER}`)).toBe(true);
    expect(isNotFound('Leave is 27 days [1].')).toBe(false);
  });
});

describe('claims of a streamed answer', () => {
  it('splits sentences also when the stream cuts between a full stop and its space', () => {
    const text = 'Leave is 27 days [1]. The carry-over is not stated in the sources.';
    const stream = new CitationStream();
    const parts = (text.match(/.{1,3}/g) ?? []).flatMap((piece) => stream.push(piece));
    parts.push(...stream.end());
    expect(claimsOf(parts, 2).map((c) => [c.citations, c.unsupported])).toEqual([
      [[1], false],
      [[], true],
    ]);
  });
});

describe('citations', () => {
  it('parses single, list, range and full-width citations', () => {
    expect(citationNumbers('1, 2')).toEqual([1, 2]);
    expect(citationNumbers('2-4')).toEqual([2, 3, 4]);
    expect(parseCitations('A [1]. B【2】. C [3, 4].').filter((p) => p.type === 'cite')).toEqual([
      { type: 'cite', n: 1 },
      { type: 'cite', n: 2 },
      { type: 'cite', n: 3 },
      { type: 'cite', n: 4 },
    ]);
  });

  it('holds a citation split across stream chunks until it closes', () => {
    const s = new CitationStream();
    expect(s.push('Leave is 27 days [')).toEqual([{ type: 'text', text: 'Leave is 27 days ' }]);
    expect(s.push('1')).toEqual([]);
    expect(s.push('2')).toEqual([]);
    expect(s.push('] and more')).toEqual([
      { type: 'cite', n: 12 },
      { type: 'text', text: ' and more' },
    ]);
    expect(s.push(' [see')).toEqual([{ type: 'text', text: ' [see' }]);
    expect(s.push(' [2')).toEqual([{ type: 'text', text: ' ' }]);
    expect(s.end()).toEqual([{ type: 'text', text: '[2' }]);
  });

  it('attaches citations to their sentence and marks sentences without one', () => {
    const claims = claimsOf(parseCitations('Leave is 27 days. [1] It is paid [2]. Ask HR. Bad cite [9].'), 2);
    expect(claims.map((c) => [c.text.trim(), c.citations, c.unsupported])).toEqual([
      ['Leave is 27 days.', [1], false],
      ['It is paid .', [2], false],
      ['Ask HR.', [], true],
      ['Bad cite .', [], true],
    ]);
  });

  it('removes think blocks from streamed text, also when a tag is split', () => {
    const f = new ThinkFilter();
    expect(
      f.push('<thi') + f.push('nk>secret</th') + f.push('ink>Answer') + f.push(' <') + f.push('b>') + f.end(),
    ).toBe('Answer <b>');
  });
});

describe('params', () => {
  it('applies overrides by name, per scope or to all scopes', () => {
    const p = applyOverrides(DEFAULT_PARAMS, [
      'rerankFloor=0.35',
      'sectionCount.strict=1',
      'rrfK=20',
      'promptVariant=strict',
    ]);
    expect(p.rerankFloor).toEqual({ strict: 0.35, balanced: 0.35, broad: 0.35 });
    expect(p.sectionCount.strict).toBe(1);
    expect(p.rrfK).toBe(20);
    expect(p.promptVariant).toBe('strict');
    expect(DEFAULT_PARAMS.rerankFloor.strict).toBe(0.5);
    expect(() => applyOverrides(DEFAULT_PARAMS, ['nope=1'])).toThrow(/unknown parameter/);
    expect(() => applyOverrides(DEFAULT_PARAMS, ['rerankFloor=2'])).toThrow(/rerankFloor/);
  });

  it('merges a partial block over the defaults and rejects unknown keys', () => {
    expect(resolveParams({ sectionCount: { strict: 1 } }).sectionCount).toEqual({ strict: 1, balanced: 3, broad: 5 });
    expect(() => resolveParams({ topK: 3 })).toThrow(/topK is not a known field/);
  });
});

describe('pipeline', () => {
  const settings: RunSettings = {
    params: DEFAULT_PARAMS,
    scope: 'balanced',
    chatModel: 'test-model',
    contextLength: 4096,
    chunkMaxChars: 1000,
    temperature: 0.1,
  };

  function setup(o: {
    reranker?: Reranker | null;
    reply?: string[];
    vector?: (lib: ReturnType<typeof fixtureLibrary>) => RawVectorHit[];
  }) {
    const lib = fixtureLibrary([
      {
        name: 'handbook.pdf',
        sections: [
          { title: 'Annual leave', parts: ['Employees get 27 days of paid annual leave per year.'], page: 2 },
          { title: 'Task teams', parts: ['Task teams are formed for each project and meet weekly.'], page: 5 },
          { title: 'Travel', parts: ['Travel is booked through the portal.'], page: 7 },
        ],
      },
      {
        name: '制度.docx',
        sections: [{ title: '年假', parts: ['员工每年享有带薪年假二十七天。'] }],
      },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    let calls = 0;
    const chat: ChatFn = async (_o, onText) => {
      calls++;
      for (const piece of o.reply ?? ['Employees get 27 days [', '1].']) onText(piece);
      return { promptTokens: 10, completionTokens: 5 };
    };
    const deps: PipelineDeps = {
      vectorSearch: async () =>
        o.vector?.(lib) ?? [
          {
            id: 'v1',
            text: lib.chunkText.get('askfiles/handbook.pdf-3-1.json'),
            metadata: { url: lib.records[0]!.url, title: 'handbook.pdf' },
            score: 0.5,
          },
          {
            id: 'v2',
            text: lib.chunkText.get('askfiles/handbook.pdf-1-1.json'),
            metadata: { url: lib.records[0]!.url, title: 'handbook.pdf' },
            score: 0.4,
          },
        ],
      resolveSources: (s) => resolver(s),
      index: lib.index,
      reranker:
        o.reranker === undefined
          ? { score: async (q, texts) => texts.map((t) => (/27 days/.test(t) ? 0.9 : 0.05)) }
          : o.reranker,
      chat,
    };
    return { lib, deps, calls: () => calls };
  }

  it('answers from the reranked section and builds cards from the section records only', async () => {
    const { deps } = setup({ reply: ['Leave is 27 days [', '1]. Files: other.pdf page 99.'] });
    const r = await retrieve('How many days of annual leave?', settings, deps);
    expect(r.vector.map((v) => v.section !== null)).toEqual([true, true]);
    const sel = choose(r, settings);
    expect(sel.selected.map((s) => s.section.title)).toEqual(['Annual leave']);
    const events: AnswerEvent[] = [];
    const result = await answer('How many days of annual leave?', r, sel, settings, deps, (e) => events.push(e));
    expect(result.notFound).toBe(false);
    expect(result.cited).toHaveLength(1);
    expect(result.cited[0]).toMatchObject({
      n: 1,
      file: 'handbook.pdf',
      title: 'Annual leave',
      path: ['Annual leave'],
      pageStart: 2,
    });
    // The model's own file and page words never reach the card.
    expect(JSON.stringify(result.cited[0])).not.toContain('other.pdf');
    expect(result.claims.map((c) => c.unsupported)).toEqual([false, true]);
    const deltas = events.filter((e) => e.type === 'delta').flatMap((e) => (e.type === 'delta' ? e.parts : []));
    expect(deltas).toContainEqual({ type: 'cite', n: 1 });
  });

  it('finds a section through the keyword index when vector search misses it', async () => {
    const { deps } = setup({
      vector: () => [],
      reranker: { score: async (_q, t) => t.map((x) => (/Task teams/.test(x) ? 0.8 : 0)) },
    });
    const r = await retrieve('what do task teams do', settings, deps);
    expect(r.keyword.length).toBeGreaterThan(0);
    expect(choose(r, settings).selected[0]!.section.title).toBe('Task teams');
  });

  it('skips the model and lists the nearest sections when nothing passes the floor', async () => {
    const { deps, calls } = setup({ reranker: { score: async (_q, t) => t.map(() => 0.001) } });
    const r = await retrieve('What is the capital of France?', settings, deps);
    const result = await answer('q', r, choose(r, settings), settings, deps);
    expect(result).toMatchObject({ notFound: true, skippedModel: true });
    // The listing path has no floor: every candidate, best reranked first, up to NEAREST_COUNT.
    expect(result.nearest.map((c) => c.title)).toEqual(r.candidates.slice(0, 8).map((c) => c.title));
    expect(result.nearest.every((c) => (c.rerank ?? 0) < 0.01)).toBe(true);
    expect(calls()).toBe(0);
  });

  it('turns the not-found marker into the not-found state without showing it', async () => {
    const { deps } = setup({ reply: ['NOT_IN', '_SOURCES'] });
    const r = await retrieve('How many days of annual leave?', settings, deps);
    const events: AnswerEvent[] = [];
    const result = await answer('q', r, choose(r, settings), settings, deps, (e) => events.push(e));
    expect(result.notFound).toBe(true);
    expect(result.cited).toEqual([]);
    expect(events.some((e) => e.type === 'delta')).toBe(false);
  });

  describe('ruleEchoRefusal (round V1)', () => {
    const echo = (on: boolean): RunSettings => ({
      ...settings,
      params: { ...DEFAULT_PARAMS, verifyCitations: true, ruleEchoRefusal: on },
    });
    const h03 =
      'The sources do not state the specific fact the question asks for, even though they discuss related material: do not answer from related material or from placeholders [1].';

    it('takes a reply that only copies the not-found rule as a refusal with the nearest sections', async () => {
      const { deps } = setup({ reply: [h03] });
      const r = await retrieve('How many days of annual leave?', settings, deps);
      const off = await answer('How many days of annual leave?', r, choose(r, echo(false)), echo(false), deps);
      expect(off.notFound).toBe(false);
      const result = await answer('How many days of annual leave?', r, choose(r, echo(true)), echo(true), deps);
      expect(result).toMatchObject({ notFound: true, claims: [], cited: [] });
      expect(result.ruleEchoes).toHaveLength(1);
      expect(result.nearest.length).toBeGreaterThan(0);
      expect(result.checked.map((c) => c.n)).toEqual([1]);
    });

    it('removes a bare marker after a partial answer and verifies the rest as an answer', async () => {
      const { deps } = setup({ reply: ['Employees get 27 days of paid annual leave [1]. NOT_IN_SOURCES[1]'] });
      const r = await retrieve('How many days of annual leave?', settings, deps);
      const result = await answer('How many days of annual leave?', r, choose(r, echo(true)), echo(true), deps);
      expect(result.notFound).toBe(false);
      expect(result.ruleEchoes).toEqual(['NOT_IN_SOURCES']);
      expect(result.claims.map((c) => c.text.trim())).toEqual(['Employees get 27 days of paid annual leave .']);
      expect(result.text).not.toContain(NOT_FOUND_MARKER);
      expect(result.cited.map((c) => c.title)).toEqual(['Annual leave']);
    });
  });

  it('bypasses an English-only reranker for a Chinese question and uses the fused order', async () => {
    let scored = false;
    const { deps } = setup({
      vector: () => [],
      reranker: {
        score: async (_q, t) => {
          scored = true;
          return t.map(() => 0);
        },
      },
    });
    const r = await retrieve('员工每年有多少天年假？', settings, deps);
    expect(scored).toBe(false);
    expect(r.bypassReason).toBe('question is mainly CJK');
    const sel = choose(r, settings);
    expect(sel.selected[0]!.section.file).toBe('制度.docx');
  });

  it('with rerankerModel none never calls the reranker and floors on vector similarity', async () => {
    let scored = false;
    const { deps } = setup({
      reranker: {
        score: async (_q, t) => {
          scored = true;
          return t.map(() => 1);
        },
      },
    });
    const off = (floor: number): RunSettings => ({
      ...settings,
      params: setFloor(structuredClone({ ...DEFAULT_PARAMS, rerankerModel: NO_RERANKER }), 'balanced', floor),
    });
    const r = await retrieve('How many days of annual leave?', off(0), deps);
    expect(scored).toBe(false);
    expect(r.bypassReason).toBe('reranker disabled');
    // Fused order: Annual leave (vector 0.4 and keyword) above Travel (vector 0.5 only).
    expect(choose(r, off(0.3)).selected.map((s) => s.section.title)).toEqual(['Annual leave', 'Travel']);
    expect(choose(r, off(0.45)).selected.map((s) => s.section.title)).toEqual(['Travel']);
    expect(choose(r, off(0.6)).selected).toEqual([]);
  });
});

describe('quoted mode', () => {
  it('normalizes whitespace, dashes, quotes, case and broken words for the excerpt check', () => {
    expect(normalizeForMatch('Natural or man‑made  accident or con- flicts, “A”')).toBe(
      normalizeForMatch('natural or man-made accident or conflicts, "a"'),
    );
  });

  it('recognizes a table of contents by its title or its dot leaders, never by numbers alone', () => {
    const sec = (title: string, text: string) => ({ title, path: ['Guide', title], text });
    expect(isContentsSection(sec('Contents', 'Intro'))).toBe(true);
    const leaders = [
      'Overview . . . . . . . 3',
      'Risk Analysis . . . . . 30',
      'Tool: Quadrant ........ 32',
      'Annex A ...... 85',
    ];
    expect(isContentsSection(sec('PPSD Sections 11', leaders.join('\n')))).toBe(true);
    expect(isContentsSection(sec('Annual leave', 'Employees get 27 days of paid annual leave per year.'))).toBe(false);
    const scores = ['Bidder A 72', 'Bidder B 65', 'Bidder C 80', 'Bidder D 58'];
    expect(isContentsSection(sec('Final Weighted Technical Score', scores.join('\n')))).toBe(false);
  });

  it('keeps only excerpts found in their own section, piece by piece, and counts the rest', () => {
    const sections = [
      { text: 'The Suspension Period shall last ten (10) Calendar Days after such confirmation.' },
      { text: 'Other text about meals and travel.' },
    ];
    expect(parseExcerpts('not json', 2)).toEqual([]);
    const ex = parseExcerpts(
      JSON.stringify({
        excerpts: [
          { source: 1, text: '"The Suspension Period shall last ten (10) Calendar Days"' },
          { source: 1, text: 'shall last ten (10) calendar days ... after such confirmation' },
          { source: 2, text: 'The Suspension Period shall last ten (10) Calendar Days' },
          { source: 1, text: 'The period lasts two weeks' },
          { source: 9, text: 'out of range' },
        ],
      }),
      2,
    );
    expect(ex).toHaveLength(4);
    const v = verifyExcerpts(ex, sections);
    expect([...v.verified.keys()]).toEqual([1]);
    expect(v.verified.get(1)).toEqual([
      'The Suspension Period shall last ten (10) Calendar Days',
      'shall last ten (10) calendar days',
      'after such confirmation',
    ]);
    expect(v.dropped).toBe(2);
  });

  const quoted: RunSettings = {
    params: { ...DEFAULT_PARAMS, answerMode: 'quoted', extractSections: 6 },
    scope: 'balanced',
    chatModel: 'test-model',
    contextLength: 4096,
    chunkMaxChars: 1000,
    temperature: 0.1,
  };

  function quotedSetup(replies: string[]) {
    const lib = fixtureLibrary([
      {
        name: 'handbook.pdf',
        sections: [
          { title: 'Annual leave', parts: ['Employees get 27 days of paid annual leave per year.'], page: 2 },
          { title: 'Travel', parts: ['Travel is booked through the portal.'], page: 7 },
        ],
      },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    const calls: { format: boolean; content: string }[] = [];
    const chat: ChatFn = async (o, onText) => {
      calls.push({ format: !!o.format, content: o.messages.map((m) => m.content).join('\n') });
      onText(replies[calls.length - 1] ?? '');
      return { promptTokens: 10, completionTokens: 5 };
    };
    const deps: PipelineDeps = {
      vectorSearch: async () => [
        {
          id: 'v1',
          text: lib.chunkText.get('askfiles/handbook.pdf-1-1.json'),
          metadata: { url: lib.records[0]!.url, title: 'handbook.pdf' },
          score: 0.8,
        },
        {
          id: 'v2',
          text: lib.chunkText.get('askfiles/handbook.pdf-2-1.json'),
          metadata: { url: lib.records[0]!.url, title: 'handbook.pdf' },
          score: 0.7,
        },
      ],
      resolveSources: (x) => resolver(x),
      index: lib.index,
      reranker: null,
      chat,
    };
    return { deps, calls };
  }

  it('extracts, verifies and composes from the verified excerpts, which the cards show', async () => {
    const extraction = JSON.stringify({
      excerpts: [
        { source: 1, text: 'Employees get 27 days of paid annual leave per year.' },
        { source: 2, text: 'Travel needs a director approval.' },
      ],
    });
    const { deps, calls } = quotedSetup([extraction, 'Employees get 27 days [1]. Travel is free [2].']);
    const r = await retrieve('How many days of annual leave?', quoted, deps);
    const result = await answer('How many days of annual leave?', r, choose(r, quoted), quoted, deps);
    expect(calls.map((c) => c.format)).toEqual([true, false]);
    expect(calls[1]!.content).toContain('Employees get 27 days of paid annual leave per year.');
    expect(calls[1]!.content).not.toContain('Travel');
    expect(result.quoted).toMatchObject({ excerpts: 2, verified: 1, dropped: 1, supported: 1 });
    expect(result.cited.map((c) => [c.title, c.passage])).toEqual([
      ['Annual leave', 'Employees get 27 days of paid annual leave per year.'],
    ]);
    // [2] has no verified excerpt: the sentence citing it is unsupported.
    expect(result.claims.map((c) => c.unsupported)).toEqual([false, true]);
  });

  it('shows the not-found state without a second call when nothing is verified', async () => {
    const { deps, calls } = quotedSetup([JSON.stringify({ excerpts: [{ source: 1, text: 'Interns get 10 days.' }] })]);
    const r = await retrieve('How many days do interns get?', quoted, deps);
    const result = await answer('How many days do interns get?', r, choose(r, quoted), quoted, deps);
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ notFound: true, skippedModel: false, cited: [] });
    expect(result.nearest.length).toBeGreaterThan(0);
    expect(result.quoted).toMatchObject({ verified: 0, dropped: 1 });
  });
});

describe('appendEvalCase', () => {
  it('writes the header once and appends rows with the section path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-case-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'q.csv');
    const c = { question: 'How long, really?', file: 'a.pdf', path: ['Leave', 'Annual'], pageStart: 3 };
    const id1 = appendEvalCase(file, c, new Date('2026-10-30T10:00:00.001Z'));
    appendEvalCase(file, c, new Date('2026-10-30T10:00:00.002Z'));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'id,category,question,expected_answer,expected_source_file,expected_section,expected_section_path,expected_page,key_elements,notes',
    );
    expect(lines[1]).toContain(`${id1},single_fact,"How long, really?",,a.pdf,Annual,Leave > Annual,3,,`);
    expect(lines[1]).not.toBe(lines[2]);
  });
});

describe('rerankerProcess', () => {
  it('runs the cross-encoder in a child process and reports its errors back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-rp-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const r = rerankerProcess({ transformersDir: dir, modelsDir: dir, repo: 'Xenova/ms-marco-MiniLM-L-6-v2' });
    try {
      expect(await r.score('q', [])).toEqual([]);
      await expect(r.score('q', ['text'])).rejects.toThrow(/reranker ms-marco-MiniLM-L-6-v2 is not installed/);
    } finally {
      r.stop();
    }
  });
});

describe('rerankerProcess idle unload', () => {
  it('ends the process after the idle time, logs it, and starts again on the next call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-rp-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logs: string[] = [];
    const r = rerankerProcess({
      transformersDir: dir,
      modelsDir: dir,
      repo: 'Xenova/ms-marco-MiniLM-L-6-v2',
      idleMs: 300,
      log: (m) => logs.push(m),
    });
    try {
      await expect(r.score('q', ['text'])).rejects.toThrow(/not installed/);
      expect(r.running()).toBe(true);
      await new Promise((res) => setTimeout(res, 800));
      expect(r.running()).toBe(false);
      expect(logs).toContain('[answer] reranker ms-marco-MiniLM-L-6-v2 unloaded after 0 min idle');
      await expect(r.score('q', ['text'])).rejects.toThrow(/not installed/);
      expect(r.running()).toBe(true);
      expect(logs.some((l) => l.startsWith('[answer] reranker ms-marco-MiniLM-L-6-v2 reloading'))).toBe(true);
    } finally {
      r.stop();
    }
  });
});

describe('ensureReranker', () => {
  it('downloads the pinned files, checks their hashes and skips them next time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-rr-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const repo = 'Xenova/ms-marco-MiniLM-L-6-v2';
    const urls: string[] = [];
    // Bodies of the right size but the wrong bytes: the hash check must refuse them.
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return new Response(new Uint8Array(4));
    }) as unknown as typeof fetch;
    await expect(ensureReranker({ repo, modelsDir: dir, fetch: fakeFetch })).rejects.toThrow(/damaged/);
    expect(urls[0]).toBe(
      'https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/a09144355adeed5f58c8ed011d209bf8ee5a1fec/config.json',
    );
    expect(fs.readdirSync(path.join(dir, 'Xenova', 'ms-marco-MiniLM-L-6-v2'))).toEqual([]);
  });
});
