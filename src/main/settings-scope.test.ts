// Answer scope from the Settings page reaches the answer pipeline (Session K, part 4): each stored
// value is the scope a question runs with, its section count and rerank floor are the ones used,
// and Balanced stands in when the store holds none.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureLibrary } from './answer/__fixtures__/library.js';
import { AnswerService, type PipelineDeps } from './answer/index.js';
import { chooseTier, loadPresets } from './presets/index.js';
import { runSettingsFor } from './settings.js';
import { ANSWER_SCOPES, defaultSettings, type Settings } from './shell-state.js';
import { createSourceResolver } from './watcher/index.js';

const presets = loadPresets(path.resolve(import.meta.dirname, '../../config/presets.json'));
const machine = chooseTier(presets, 16 * 1024 ** 3).preset;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function pipeline(): PipelineDeps {
  const lib = fixtureLibrary([
    {
      name: 'handbook.pdf',
      sections: [
        { title: 'Annual leave', parts: ['Employees get 27 days of paid annual leave per year.'], page: 2 },
        { title: 'Sick leave', parts: ['Sick leave needs a note after three days.'], page: 3 },
        { title: 'Travel', parts: ['Travel is booked through the portal.'], page: 4 },
      ],
    },
  ]);
  cleanups.push(lib.cleanup);
  const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
  return {
    vectorSearch: async () =>
      [1, 2, 3].map((i) => ({
        id: `v${i}`,
        text: lib.chunkText.get(`askfiles/handbook.pdf-${i}-1.json`),
        metadata: { url: lib.records[0]!.url, title: 'handbook.pdf' },
        score: 0.5,
      })),
    resolveSources: (s) => resolver(s),
    index: lib.index,
    reranker: { score: async (_q, texts) => texts.map(() => 0.99) },
    chat: async (_o, onText) => {
      onText('Employees get 27 days [1].');
      return { promptTokens: 1, completionTokens: 1 };
    },
  };
}

/** One question through the answer service with the settings store holding stored. */
async function traceFor(stored: Partial<Settings> | null) {
  const deps = pipeline();
  const service = new AnswerService({
    pipeline: () => deps,
    // As AppController.runSettings: read from the store for every question.
    settings: () => runSettingsFor({ presets, machine, settings: stored, chatModel: 'qwen3:8b' }),
    developer: true,
    evalQuestionsFile: '/dev/null',
    log: () => {},
  });
  await service.askOnce('How many days of annual leave?');
  return service.developerState().trace!;
}

describe('answer scope from the settings store', () => {
  for (const scope of ANSWER_SCOPES) {
    it(`runs a question with scope ${scope} and its section count and rerank floor`, async () => {
      const trace = await traceFor({ ...defaultSettings(), answerScope: scope });
      expect(trace.scope).toBe(scope);
      expect(trace.count).toBe(machine.answer.sectionCount[scope]);
      expect(trace.floor).toBe(machine.answer.rerankFloor[scope]);
      expect(trace.candidates.filter((c) => c.selected).length).toBeLessThanOrEqual(machine.answer.sectionCount[scope]);
    });
  }

  it('falls back to Balanced when the store holds no scope or an unknown one', async () => {
    expect((await traceFor(null)).scope).toBe('balanced');
    expect((await traceFor({ answerScope: 'wide' as never })).scope).toBe('balanced');
  });

  it('takes the context length from the Settings page', () => {
    const s = runSettingsFor({
      presets,
      machine,
      settings: { ...defaultSettings(), contextLength: 16384 },
      chatModel: 'm',
    });
    expect(s.contextLength).toBe(16384);
    expect(runSettingsFor({ presets, machine, settings: null, chatModel: 'm' }).contextLength).toBe(
      machine.contextLength,
    );
  });
});
