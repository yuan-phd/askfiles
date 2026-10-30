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
  it('scores a section by the reciprocal ranks of all its chunks and its keyword hit', () => {
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
    expect(fused.map((f) => f.key)).toEqual([b, a, c]);
    expect(fused[0]!.score).toBeCloseTo(rrf(1, 60) + rrf(3, 60));
    expect(fused[1]).toMatchObject({ vectorRank: 2, keywordRank: 2, terms: ['leave'] });
    expect(fused[1]!.score).toBeCloseTo(rrf(2, 60) + rrf(2, 60));
    expect(fused[0]!.hitTexts).toEqual(['x', 'z']);
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
      bypass: false,
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
      { count: 3, floor: 0.5, budgetTokens: 100_000, bypass: true },
    );
    expect(sel.selected.map((s) => s.section.key)).toEqual(['a', 'b', 'c']);
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
    expect(result.nearest.length).toBeGreaterThan(0);
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
