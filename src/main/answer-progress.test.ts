// Progress events while an answer is prepared (display only): searching, the judge's calls per
// named file (n of N, display names), writing, then the answer; nothing after a cancel. A fake
// model answers the judge with a digit and the answer with text. Invented documents only.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureLibrary } from './answer/__fixtures__/library.js';
import { AnswerService, JUDGE_SYSTEM, type ChatFn, type PipelineDeps } from './answer/index.js';
import { chooseTier, loadPresets } from './presets/index.js';
import { runSettingsFor } from './settings.js';
import { createSourceResolver } from './watcher/index.js';

const presets = loadPresets(path.resolve(import.meta.dirname, '../../config/presets.json'));
const machine = chooseTier(presets, 16 * 1024 ** 3).preset;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUESTION = 'Compare the Pump Station Procedure 2025 and the Valve Exercising Guidance on isolation.';

function setup(judgeDelayMs = 0) {
  const lib = fixtureLibrary([
    {
      name: '03_Pump_Station_Procedure_2025.pdf',
      sections: [
        { title: 'Isolation', parts: ['Close the inlet valve before isolation of the pump.'], page: 1 },
        { title: 'Start up', parts: ['Open the outlet valve slowly at start up.'], page: 2 },
        { title: 'Permits', parts: ['A permit to work is needed for isolation.'], page: 3 },
      ],
    },
    {
      name: 'Valve_Exercising_Guidance.pdf',
      sections: [
        { title: 'Isolation valves', parts: ['Isolation valves are exercised once a year.'], page: 1 },
        { title: 'Records', parts: ['Every exercise is written in the valve record.'], page: 2 },
      ],
    },
  ]);
  cleanups.push(lib.cleanup);
  const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
  const judged: number[] = [];
  const chat: ChatFn = async (o, onText) => {
    if (o.messages[0]?.content === JUDGE_SYSTEM) {
      judged.push(Date.now());
      await sleep(judgeDelayMs);
      if (o.signal?.aborted) throw new Error('aborted');
      onText('2');
    } else onText('Close the inlet valve first [1].');
    return { promptTokens: 1, completionTokens: 1 };
  };
  const deps: PipelineDeps = {
    vectorSearch: async () =>
      lib.records.flatMap((r) =>
        r.sections.map((s) => ({
          id: s.location,
          text: lib.chunkText.get(s.location),
          metadata: { url: r.url, title: path.basename(r.path) },
          score: 0.9,
        })),
      ),
    resolveSources: (s) => resolver(s),
    index: lib.index,
    reranker: null,
    chat,
  };
  const logs: string[] = [];
  const answers = new AnswerService({
    pipeline: () => deps,
    settings: () => runSettingsFor({ presets, machine, settings: null, chatModel: 'qwen3:8b' }),
    developer: false,
    evalQuestionsFile: '/dev/null',
    log: (m) => logs.push(m),
  });
  return { answers, judged, logs };
}

type Ev = { type: string; progress?: { stage: string; file?: string; n?: number; total?: number } };

describe('answer progress events', () => {
  it('searching, each judge call per named file with its display name, writing, then the answer', async () => {
    expect(machine.answer.judgeRerank, 'the preset runs the judge').toBe(true);
    const { answers, judged } = setup();
    const events: Ev[] = [];
    await new Promise<void>((resolve) => {
      answers.ask(QUESTION, (e) => {
        events.push(e as Ev);
        if (e.type === 'done' || e.type === 'error') resolve();
      });
    });
    expect(events.at(-1)!.type).toBe('done');
    const progress = events.filter((e) => e.type === 'progress').map((e) => e.progress!);
    const judging = progress.filter((p) => p.stage === 'judging');
    // One progress event per judge call, numbered 1..N within each file, files in the order named.
    expect(judging).toHaveLength(judged.length);
    expect(judging.length).toBeGreaterThan(0);
    const files = [...new Set(judging.map((p) => p.file))];
    expect(files).toEqual(['Pump Station Procedure 2025', 'Valve Exercising Guidance']);
    for (const f of files) {
      const mine = judging.filter((p) => p.file === f);
      expect(mine.map((p) => p.n)).toEqual(mine.map((_, i) => i + 1));
      expect(new Set(mine.map((p) => p.total))).toEqual(new Set([mine.length]));
    }
    expect(progress[0]).toEqual({ stage: 'searching' });
    expect(progress.at(-1)).toEqual({ stage: 'writing' });
    // Writing comes after the last judge call and before the first words.
    const order = events.map((e) => (e.type === 'progress' ? e.progress!.stage : e.type));
    expect(order.lastIndexOf('judging')).toBeLessThan(order.indexOf('writing'));
    expect(order.indexOf('writing')).toBeLessThan(order.indexOf('delta'));
  });

  it('a question naming no file has no judge progress', async () => {
    const { answers } = setup();
    const events: Ev[] = [];
    await new Promise<void>((resolve) => {
      answers.ask('How is a pump isolated?', (e) => {
        events.push(e as Ev);
        if (e.type === 'done' || e.type === 'error') resolve();
      });
    });
    expect(events.filter((e) => e.type === 'progress').map((e) => e.progress!.stage)).toEqual(['searching', 'writing']);
  });

  it('a cancelled answer sends no progress after the cancel', async () => {
    const { answers, judged } = setup(40);
    const events: { e: Ev; at: number }[] = [];
    answers.ask(QUESTION, (e) => events.push({ e: e as Ev, at: Date.now() }));
    await (async () => {
      for (let i = 0; i < 200 && judged.length < 2; i++) await sleep(5);
    })();
    const cut = Date.now();
    expect(answers.cancelCurrent('the library changed to lib-b')).toBe(true);
    await (async () => {
      for (let i = 0; i < 200 && answers.busy(); i++) await sleep(5);
    })();
    await sleep(150);
    expect(events.some((x) => x.e.type === 'progress' && x.e.progress!.stage === 'judging')).toBe(true);
    expect(events.filter((x) => x.at > cut)).toEqual([]);
  });
});
