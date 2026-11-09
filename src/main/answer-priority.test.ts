// Answers take priority over summaries (docs/summaries.md, Queue): a question that starts while a
// summary is being generated aborts that model request, reaches the model without waiting for it,
// and the aborted summary is made again once the answer is done and the idle wait has passed.
// The answer service and the summary service are wired as AppController wires them (onBusy ->
// setAnswering), over one fake model that takes one request at a time, as Ollama does with one slot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureLibrary } from './answer/__fixtures__/library.js';
import { AnswerService, type ChatFn, type PipelineDeps } from './answer/index.js';
import { buildGraph, loadProfiles, profileFor } from './graph/index.js';
import { chooseTier, loadPresets } from './presets/index.js';
import { runSettingsFor } from './settings.js';
import { SummaryService } from './summaries/index.js';
import { createSourceResolver } from './watcher/index.js';

const presets = loadPresets(path.resolve(import.meta.dirname, '../../config/presets.json'));
const machine = chooseTier(presets, 16 * 1024 ** 3).preset;
const profile = profileFor(loadProfiles(path.resolve(import.meta.dirname, '../../config/profiles')), 'legal-finance');
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(5);
  }
}

/**
 * One model slot. A request waits for the slot, then generates: the first summary request takes
 * SLOW_MS (a long summary in progress), every other request a few milliseconds. An aborted request
 * frees the slot at once, as Ollama stops a request whose connection is closed.
 */
const SLOW_MS = 4000;
function serialModel() {
  let busy: Promise<void> = Promise.resolve();
  const log: { kind: 'summary' | 'answer'; event: 'start' | 'end' | 'aborted'; at: number }[] = [];
  let summaries = 0;
  const t0 = Date.now();
  const run = async (kind: 'summary' | 'answer', signal: AbortSignal | undefined, text: string) => {
    const before = busy;
    let release!: () => void;
    busy = new Promise((r) => (release = r));
    await before;
    try {
      if (signal?.aborted) throw new Error('aborted');
      log.push({ kind, event: 'start', at: Date.now() - t0 });
      const ms = kind === 'summary' && summaries++ === 0 ? SLOW_MS : 5;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          log.push({ kind, event: 'aborted', at: Date.now() - t0 });
          reject(new Error('aborted'));
        });
      });
      log.push({ kind, event: 'end', at: Date.now() - t0 });
      return text;
    } finally {
      release();
    }
  };
  return { run, log };
}

describe('answers take priority over summaries', () => {
  it('a question aborts the summary in progress, reaches the model at once, and the summary is made again after', async () => {
    const lib = fixtureLibrary([
      {
        name: 'handbook.pdf',
        sections: [
          { title: 'Annual leave', parts: ['Employees get 27 days of paid annual leave per year.'], page: 2 },
          { title: 'Sick leave', parts: ['Sick leave needs a note after three days.'], page: 3 },
        ],
      },
    ]);
    cleanups.push(lib.cleanup);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-priority-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const model = serialModel();
    const logs: string[] = [];

    const summaryChat: ChatFn = async (o, onText) => {
      onText(await model.run('summary', o.signal, 'Employees get 27 days of paid annual leave per year.'));
      return { promptTokens: null, completionTokens: null };
    };
    const summaries = new SummaryService({
      browse: lib.index,
      dir: path.join(tmp, 'summaries'),
      exportDir: path.join(tmp, 'export'),
      chat: summaryChat,
      model: () => ({ model: 'qwen3:8b', contextLength: 8192, temperature: 0.1 }),
      librarySections: () => false,
      graph: () => buildGraph(lib.index.allDocuments(), { profile }),
      idleMs: 50,
      exportDebounceMs: 10,
      log: (m) => logs.push(m),
    });
    cleanups.push(() => summaries.stop());

    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    let answerAskedAt: number | null = null;
    const deps: PipelineDeps = {
      vectorSearch: async () =>
        [1, 2].map((i) => ({
          id: `v${i}`,
          text: lib.chunkText.get(`askfiles/handbook.pdf-${i}-1.json`),
          metadata: { url: lib.records[0]!.url, title: 'handbook.pdf' },
          score: 0.9,
        })),
      resolveSources: (s) => resolver(s),
      index: lib.index,
      reranker: { score: async (_q, texts) => texts.map(() => 0.99) },
      chat: async (o, onText) => {
        answerAskedAt ??= Date.now();
        onText(await model.run('answer', o.signal, 'Employees get 27 days [1].'));
        return { promptTokens: 1, completionTokens: 1 };
      },
    };
    const answers = new AnswerService({
      pipeline: () => deps,
      settings: () => runSettingsFor({ presets, machine, settings: null, chatModel: 'qwen3:8b' }),
      developer: false,
      evalQuestionsFile: '/dev/null',
      log: () => {},
      // As AppController: the queue gives way to every question.
      onBusy: (b) => summaries.setAnswering(b),
    });

    summaries.reconcile();
    const id = lib.index.allDocuments()[0]!.id;
    // The summary is being generated.
    await until(() => model.log.some((e) => e.kind === 'summary' && e.event === 'start'));
    expect(summaries.status()).toMatchObject({ state: 'running' });

    const asked = Date.now();
    const result = await answers.askOnce('How many days of annual leave?');
    expect(result.text).toContain('27 days');
    // The answer reached the model without waiting the 4 s of the summary in progress.
    const answerStart = model.log.find((e) => e.kind === 'answer' && e.event === 'start')!;
    const aborted = model.log.find((e) => e.kind === 'summary' && e.event === 'aborted')!;
    expect(aborted, 'the summary request was cancelled').toBeTruthy();
    expect(answerStart.at).toBeGreaterThanOrEqual(aborted.at);
    expect(answerAskedAt! - asked).toBeLessThan(1000);
    expect(Date.now() - asked).toBeLessThan(SLOW_MS / 2);
    expect(
      logs.some((l) => /^\[summaries\] aborted .+:doc for answering; back at the front of the queue$/.test(l)),
    ).toBe(true);
    // Not counted as done, back at the front: nothing else to do here, so it is the next job.
    expect(summaries.view(id)!.state).toBe('pending');

    // After the answer and the idle wait, the aborted summary is made again.
    await until(() => summaries.view(id)!.state === 'ok', 3000);
    const starts = model.log.filter((e) => e.kind === 'summary' && e.event === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.at).toBeGreaterThan(model.log.find((e) => e.kind === 'answer' && e.event === 'end')!.at + 40);
  });
});

describe('switching library cancels a running answer', () => {
  it('cancelCurrent aborts the model request and no event of that answer follows', async () => {
    const lib = fixtureLibrary([
      {
        name: 'handbook.pdf',
        sections: [{ title: 'Annual leave', parts: ['Employees get 27 days of paid annual leave per year.'], page: 2 }],
      },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    let modelSignal: AbortSignal | undefined;
    const deps: PipelineDeps = {
      vectorSearch: async () => [
        {
          id: 'v1',
          text: lib.chunkText.get('askfiles/handbook.pdf-1-1.json'),
          metadata: { url: lib.records[0]!.url, title: 'handbook.pdf' },
          score: 0.9,
        },
      ],
      resolveSources: (s) => resolver(s),
      index: lib.index,
      reranker: { score: async (_q, texts) => texts.map(() => 0.99) },
      // A long answer: a few words every 20 ms until it is aborted.
      chat: async (o, onText) => {
        modelSignal = o.signal;
        for (let i = 0; i < 200; i++) {
          if (o.signal?.aborted) throw new Error('aborted');
          onText(`word${i} `);
          await sleep(20);
        }
        return { promptTokens: 1, completionTokens: 1 };
      },
    };
    const logs: string[] = [];
    const answered: { cancelled: boolean }[] = [];
    const answers = new AnswerService({
      pipeline: () => deps,
      settings: () => runSettingsFor({ presets, machine, settings: null, chatModel: 'qwen3:8b' }),
      developer: false,
      evalQuestionsFile: '/dev/null',
      log: (m) => logs.push(m),
      onAnswered: (r) => answered.push({ cancelled: r.cancelled }),
    });
    const events: { type: string; at: number }[] = [];
    answers.ask('How many days of annual leave?', (e) => events.push({ type: e.type, at: Date.now() }));
    await until(() => events.filter((e) => e.type === 'delta').length >= 3);
    expect(answers.busy()).toBe(true);

    // What AppController.saveState does when the current library changes.
    const cut = Date.now();
    expect(answers.cancelCurrent('the library changed to lib-b')).toBe(true);
    const seen = events.length;
    await until(() => !answers.busy());
    await sleep(200);
    expect(modelSignal?.aborted).toBe(true);
    expect(events.length).toBe(seen);
    expect(events.every((e) => e.at <= cut)).toBe(true);
    expect(events.some((e) => e.type === 'done' || e.type === 'error')).toBe(false);
    expect(logs).toContain('[answer] cancelled: the library changed to lib-b');
    expect(answered).toEqual([{ cancelled: true }]);
    // Nothing to cancel any more.
    expect(answers.cancelCurrent('again')).toBe(false);
  });
});
