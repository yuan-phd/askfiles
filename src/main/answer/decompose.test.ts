import { describe, expect, it } from 'vitest';
import { claimsOf, parseCitations } from './citations.js';
import { answerSplit, PART_NOT_FOUND, splitQuestion, type SubQuestion } from './decompose.js';
import type { AnswerEvent, AnswerResult, SourceCard } from './pipeline.js';

describe('splitQuestion', () => {
  it('splits coordinated asks after a lead-in and keeps the sentences around them', () => {
    const s = splitQuestion(
      'According to the Preamble in the Template, which system is used to prepare Plans, and what two components constitute the Plan? Cite the Word section.',
    );
    expect(s?.how).toBe('asks');
    expect(s?.parts.map((p) => p.text)).toEqual([
      'According to the Preamble in the Template, which system is used to prepare Plans? Cite the Word section.',
      'According to the Preamble in the Template, what two components constitute the Plan? Cite the Word section.',
    ]);
    expect(s?.parts.map((p) => p.label)).toEqual([
      'Which system is used to prepare Plans?',
      'What two components constitute the Plan?',
    ]);
  });

  it('splits a comma list of asks, with as well as and a preposition before the question word', () => {
    const s = splitQuestion(
      'In the example under Final Score, what score does Bidder A receive, which bidder scores highest, as well as to whom is the report sent?',
    );
    expect(s?.parts.map((p) => p.label)).toEqual([
      'What score does Bidder A receive?',
      'Which bidder scores highest?',
      'To whom is the report sent?',
    ]);
  });

  it('splits Compare A and B into one part per member and drops the sentences after it', () => {
    const s = splitQuestion(
      'Compare the Maintenance Policy and the 2024 Directive: who must develop the Plan? Cite both documents.',
    );
    expect(s).toEqual({
      how: 'set',
      parts: [
        { text: 'In the Maintenance Policy, who must develop the Plan?', label: 'The Maintenance Policy' },
        { text: 'In the 2024 Directive, who must develop the Plan?', label: 'The 2024 Directive' },
      ],
    });
  });

  it('resolves the former and the latter against two members named before the asks', () => {
    const s = splitQuestion(
      'Using Value Guidance and Contract Guidance, answer: what does SMART mean in the former, and what should accompany KPIs according to the latter?',
    );
    expect(s?.parts.map((p) => p.label)).toEqual([
      'What does SMART mean in Value Guidance?',
      'What should accompany KPIs according to Contract Guidance?',
    ]);
  });

  it('leaves a question whole when a later ask points back or nothing resolves the former', () => {
    expect(
      splitQuestion('Under paragraph 5.79, what starts the Suspension Period, and how long does it last?'),
    ).toBeNull();
    expect(
      splitQuestion('In the Guidance, what is the risk owner, and for how long should that owner act?'),
    ).toBeNull();
    expect(splitQuestion('In the guides, what does the former say, and what does the latter add?')).toBeNull();
  });

  it('leaves a question whole without a lead-in, with two question sentences, or with one ask', () => {
    expect(splitQuestion('Which German authority handles reviews, and what is the statutory procedure?')).toBeNull();
    expect(splitQuestion('In the workbook, what would C28 return? What would it return if C22 changed?')).toBeNull();
    expect(splitQuestion('In the Template, what catalogue number and designation appear on the cover?')).toBeNull();
    expect(splitQuestion('In the guides, identify the office, the date, and the SUBJECT.')).toBeNull();
  });

  it('joins a one-word ask such as why to the ask before it', () => {
    const s = splitQuestion(
      'In the workbook, what formula is stored in C28, what does the workbook display, why, and under what condition does C30 return 1?',
    );
    expect(s?.parts.map((p) => p.label)).toEqual([
      'What formula is stored in C28?',
      'What does the workbook display, why?',
      'Under what condition does C30 return 1?',
    ]);
  });
});

const card = (n: number, documentId: string, sectionIndex: number): SourceCard => ({
  n,
  file: `${documentId}.pdf`,
  relPath: `${documentId}.pdf`,
  url: `custom-documents/${documentId}.json`,
  documentId,
  sectionIndex,
  title: `S${sectionIndex}`,
  path: [`S${sectionIndex}`],
  pageStart: 1,
  pageEnd: 1,
  pageLabel: null,
  passage: `text of ${documentId} ${sectionIndex}`,
  rerank: null,
  trimmed: false,
});

function result(text: string, sources: SourceCard[], notFound = false): AnswerResult {
  const claims = notFound ? [] : claimsOf(parseCitations(text), sources.length);
  const cited = [...new Set(claims.flatMap((c) => c.citations))].map((n) => sources[n - 1]!);
  return {
    text,
    notFound,
    claims,
    cited: notFound ? [] : cited,
    considered: notFound ? [] : sources.filter((s) => !cited.includes(s)),
    nearest: sources,
    checked: [],
    skippedModel: false,
    timings: { firstTokenMs: 5, modelMs: 10 },
    stats: { promptTokens: 100, completionTokens: 20 },
  };
}

const split = (n: number) => ({
  how: 'asks' as const,
  parts: Array.from({ length: n }, (_, i) => ({ text: `In X, ask ${i + 1}?`, label: `Ask ${i + 1}?` })),
});

/** A fake pipeline: each part's sources, its reply, emitted as the real one does. */
function fakeRun(per: { sources: SourceCard[]; text: string; notFound?: boolean }[]) {
  let i = 0;
  return async (_part: SubQuestion, emit: (e: AnswerEvent) => void) => {
    const p = per[i++]!;
    emit({ type: 'stage', stage: 'answering' });
    emit({ type: 'sources', sources: p.sources });
    if (!p.notFound) emit({ type: 'delta', parts: parseCitations(p.text) });
    return result(p.text, p.sources, p.notFound);
  };
}

describe('answerSplit', () => {
  it('renumbers citations against the union of sources and merges a shared one', async () => {
    const events: AnswerEvent[] = [];
    const r = await answerSplit(
      split(2),
      fakeRun([
        { sources: [card(1, 'a', 1), card(2, 'a', 2)], text: 'First fact [2].' },
        { sources: [card(1, 'b', 7), card(2, 'a', 2)], text: 'Second fact [1]. Third fact [2].' },
      ]),
      (e) => events.push(e),
    );
    expect(r.text).toBe('Ask 1?\nFirst fact [2].\n\nAsk 2?\nSecond fact [3]. Third fact [2].');
    expect(r.claims.map((c) => [c.text.trim(), c.citations])).toEqual([
      ['Ask 1?', []],
      ['First fact .', [2]],
      ['Ask 2?', []],
      ['Second fact .', [3]],
      ['Third fact .', [2]],
    ]);
    expect(r.cited.map((c) => [c.n, c.documentId, c.sectionIndex])).toEqual([
      [2, 'a', 2],
      [3, 'b', 7],
    ]);
    expect(r.considered.map((c) => c.n)).toEqual([1]);
    expect(r.notFound).toBe(false);
    expect(r.split).toEqual({
      how: 'asks',
      parts: ['In X, ask 1?', 'In X, ask 2?'],
      notFound: [false, false],
      ms: [expect.any(Number), expect.any(Number)],
    });
    // Streamed: the sources list only grows, numbers shown stay, citations use merged numbers.
    const sources = events.filter((e) => e.type === 'sources').map((e) => e.sources.map((c) => c.n));
    expect(sources).toEqual([
      [1, 2],
      [1, 2, 3],
    ]);
    const streamed = events
      .filter((e) => e.type === 'delta')
      .flatMap((e) => e.parts)
      .map((p) => (p.type === 'cite' ? `[${p.n}]` : p.text))
      .join('');
    expect(streamed).toBe('Ask 1?\nFirst fact [2].\n\nAsk 2?\nSecond fact [3]. Third fact [2].');
    expect(events.filter((e) => e.type === 'stage')).toHaveLength(1);
    expect(r.stats).toEqual({ promptTokens: 200, completionTokens: 40 });
  });

  it('says a part is not found under its lead-in, and is not found only when every part is', async () => {
    const partly = await answerSplit(
      split(2),
      fakeRun([
        { sources: [card(1, 'a', 1)], text: 'Fact [1].' },
        { sources: [card(1, 'b', 1)], text: 'NOT_IN_SOURCES', notFound: true },
      ]),
    );
    expect(partly.notFound).toBe(false);
    expect(partly.text).toBe(`Ask 1?\nFact [1].\n\nAsk 2?\n${PART_NOT_FOUND}`);
    expect(partly.claims.filter((c) => c.unsupported)).toEqual([]);
    expect(partly.cited.map((c) => c.documentId)).toEqual(['a']);
    const none = await answerSplit(
      split(2),
      fakeRun([
        { sources: [card(1, 'a', 1)], text: 'NOT_IN_SOURCES', notFound: true },
        { sources: [card(1, 'a', 1), card(2, 'b', 1)], text: 'NOT_IN_SOURCES', notFound: true },
      ]),
    );
    expect(none.notFound).toBe(true);
    expect(none.cited).toEqual([]);
    expect(none.nearest.map((c) => [c.n, c.documentId])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });
});
