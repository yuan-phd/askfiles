// The test build's main-process part (docs/test-build.md): its IPC channels against the preload's,
// export to the Desktop with the file revealed, pause and clear over IPC, adding files recorded
// through the wrapped handlers, a real question through the answer service, and the UI files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureLibrary } from '../answer/__fixtures__/library.js';
import { AnswerService, type PipelineDeps } from '../answer/index.js';
import type { BridgeHandlers } from '../bridge/contract.js';
import { chooseTier, loadPresets } from '../presets/index.js';
import { runSettingsFor } from '../settings.js';
import type { TestBuildDeps } from '../test-build.js';
import { createSourceResolver } from '../watcher/index.js';
import { ASSET_PREFIX, createTestBuild, MODULE_MARKER, TEST_CHANNELS, TITLE_SUFFIX } from './index.js';
import { readRecord } from './record.js';

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-test-build-'));
  dirs.push(d);
  return d;
}

type Listener = (event: unknown, ...args: unknown[]) => unknown;
function fakeIpc() {
  const handlers = new Map<string, Listener>();
  return {
    handle: (channel: string, l: Listener) => void handlers.set(channel, l),
    on: () => {},
    call: (channel: string, ...args: unknown[]) => {
      const l = handlers.get(channel);
      if (!l) throw new Error(`no handler for ${channel}`);
      return l({}, ...args);
    },
    handlers,
  };
}

function setup(over: Partial<TestBuildDeps> = {}) {
  const dataDir = tmp();
  const desktopDir = tmp();
  const revealed: string[] = [];
  const logs: string[] = [];
  const deps: TestBuildDeps = {
    dataDir,
    desktopDir,
    version: '0.1.0',
    platform: 'darwin',
    log: (m) => logs.push(m),
    showItemInFolder: (f) => revealed.push(f),
    libraryName: () => 'Work',
    ...over,
  };
  const build = createTestBuild(deps, { now: () => new Date(2026, 10, 7, 12, 0, 0) });
  const ipc = fakeIpc();
  build.registerIpc(ipc);
  const recordFile = path.join(dataDir, 'test-record', 'record.jsonl');
  return { build, ipc, dataDir, desktopDir, revealed, logs, recordFile };
}

describe('test build module', () => {
  it('names the window a test build and carries the marker the release check looks for', () => {
    const { build, logs } = setup();
    expect(build.titleSuffix).toBe(TITLE_SUFFIX);
    expect(TITLE_SUFFIX).toBe(' (test build)');
    expect(MODULE_MARKER).toBe('askfiles-test-record-module');
    expect(path.basename(build.preloadFile)).toBe('preload.js');
    expect(logs[0]).toMatch(/^\[test-record\] test build: 0 lines in /);
  });

  it('uses the same channel names as its preload script', () => {
    const preload = fs.readFileSync(path.join(import.meta.dirname, 'preload.ts'), 'utf8');
    const used = [...preload.matchAll(/'(askfiles-test:[a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(used).toEqual(Object.values(TEST_CHANNELS).sort());
    expect(fakeIpcChannels()).toEqual(Object.values(TEST_CHANNELS).sort());
  });

  it('exports to the Desktop in both modes and reveals the file', async () => {
    const { ipc, desktopDir, revealed } = setup();
    await ipc.call(TEST_CHANNELS.record, { type: 'browse', page: 'document', document: 'Handbook' });
    const full = (await ipc.call(TEST_CHANNELS.export, 'full')) as { file: string };
    expect(path.dirname(full.file)).toBe(desktopDir);
    expect(fs.readFileSync(full.file, 'utf8')).toContain('"document":"Handbook"');
    const questions = (await ipc.call(TEST_CHANNELS.export, 'anything else')) as { file: string };
    expect(path.basename(questions.file)).toMatch(/^AskFiles test record questions only /);
    expect(fs.readFileSync(questions.file, 'utf8')).not.toContain('Handbook');
    expect(revealed).toEqual([full.file, questions.file]);
  });

  it('pauses, resumes and clears over its channels, and remembers the notice', async () => {
    const { ipc, recordFile } = setup();
    expect(await ipc.call(TEST_CHANNELS.record, { type: 'browse', page: 'find' })).toBe(true);
    expect(await ipc.call(TEST_CHANNELS.pause, true)).toMatchObject({ paused: true, events: 1 });
    await ipc.call(TEST_CHANNELS.record, { type: 'browse', page: 'graph' });
    expect(readRecord(recordFile)).toHaveLength(1);
    expect(await ipc.call(TEST_CHANNELS.pause, 'yes')).toMatchObject({ paused: false });
    await ipc.call(TEST_CHANNELS.record, { type: 'browse', page: 'graph' });
    expect(await ipc.call(TEST_CHANNELS.status)).toMatchObject({ events: 2, noticeShown: false, platform: 'darwin' });
    expect(await ipc.call(TEST_CHANNELS.clear)).toMatchObject({ events: 0 });
    expect(await ipc.call(TEST_CHANNELS.noticeShown)).toMatchObject({ noticeShown: true });
    expect(await ipc.call(TEST_CHANNELS.record, { type: 'nonsense' })).toBe(false);
  });

  it('records adding files as counts, never the paths, and passes every other handler through', async () => {
    const { build, recordFile } = setup();
    class Fake {
      private calls = 0;
      async librariesAddFiles() {
        this.calls++;
        return { added: 3, skipped: [{ name: 'secret plans.exe', reason: 'unsupported' }] };
      }
      async librariesAddFolder() {
        return null;
      }
      async librariesAddPaths(paths: string[]) {
        return { added: paths.length, skipped: [] };
      }
      count() {
        return this.calls;
      }
    }
    const inner = new Fake();
    const h = build.wrapHandlers(inner as unknown as BridgeHandlers);
    expect(await h.librariesAddFiles()).toMatchObject({ added: 3 });
    expect(await h.librariesAddFolder()).toBeNull();
    await h.librariesAddPaths(['/Users/anna/Private/a.pdf', '/Users/anna/Private/b']);
    // Methods that are not wrapped still run on the instance itself.
    expect((h as unknown as Fake).count()).toBe(1);
    const lines = readRecord(recordFile);
    expect(lines.map((l) => l.type === 'add' && [l.kind, l.added, l.skipped, l.library])).toEqual([
      ['files', 3, 1, 'Work'],
      ['drop', 2, 0, 'Work'],
    ]);
    expect(fs.readFileSync(recordFile, 'utf8')).not.toMatch(/anna|secret|\.pdf/);
  });

  it('serves the test UI from its own folder and nothing outside it', () => {
    const uiDir = tmp();
    const build = createTestBuild(
      {
        dataDir: tmp(),
        desktopDir: tmp(),
        version: '0',
        platform: 'linux',
        log: () => {},
        showItemInFolder: () => {},
        libraryName: () => null,
      },
      { uiDir },
    );
    expect(build.resolveAsset(`${ASSET_PREFIX}ui.js`)).toBe(path.join(uiDir, 'ui.js'));
    expect(build.resolveAsset('/test-record/../../secret')).toBeNull();
    expect(build.resolveAsset('/ask/index.html')).toBeNull();
    expect(build.resolveAsset('/test-record/\0x')).toBeNull();
  });
});

function fakeIpcChannels(): string[] {
  const ipc = fakeIpc();
  createTestBuild({
    dataDir: tmp(),
    desktopDir: tmp(),
    version: '0',
    platform: 'linux',
    log: () => {},
    showItemInFolder: () => {},
    libraryName: () => null,
  }).registerIpc(ipc);
  return [...ipc.handlers.keys()].sort();
}

describe('questions through the answer service', () => {
  const presets = loadPresets(path.resolve(import.meta.dirname, '../../../config/presets.json'));
  const machine = chooseTier(presets, 16 * 1024 ** 3).preset;
  function pipeline(): PipelineDeps {
    const lib = fixtureLibrary([
      {
        name: 'handbook.pdf',
        sections: [
          { title: 'Annual leave', parts: ['Employees get 27 days of paid annual leave per year.'], page: 2 },
          { title: 'Travel', parts: ['Travel is booked through the portal.'], page: 4 },
        ],
      },
    ]);
    cleanups.push(lib.cleanup);
    const resolver = createSourceResolver({ files: () => lib.records, readText: (l) => lib.chunkText.get(l) ?? null });
    return {
      vectorSearch: async () =>
        [1, 2].map((i) => ({
          id: `v${i}`,
          text: lib.chunkText.get(`askfiles/handbook.pdf-${i}-1.json`),
          metadata: { url: lib.records[0]!.url, title: 'handbook.pdf' },
          // Above every scope's vector floor, so the model is asked.
          score: 0.9,
        })),
      resolveSources: (s) => resolver(s),
      index: lib.index,
      reranker: { score: async (_q, texts) => texts.map(() => 0.99) },
      chat: async (_o, onText) => {
        onText('Employees get 27 days of paid annual leave per year [1]. The moon is made of cheese.');
        return { promptTokens: 1, completionTokens: 1 };
      },
    };
  }
  const service = (deps: PipelineDeps | null, onAnswered?: (r: never) => void) =>
    new AnswerService({
      pipeline: () => deps,
      settings: () => runSettingsFor({ presets, machine, settings: null, chatModel: 'qwen3:8b' }),
      developer: false,
      evalQuestionsFile: '/dev/null',
      log: () => {},
      ...(onAnswered ? { onAnswered } : {}),
    });

  it('records an answered question and leaves the answer as it is without the record', async () => {
    const { build, recordFile } = setup();
    const withRecord = await service(pipeline(), (r) => build.onAnswered(r)).askOnce('How many days of annual leave?');
    const without = await service(pipeline()).askOnce('How many days of annual leave?');
    expect(withRecord.text).toBe(without.text);
    expect(withRecord.claims).toEqual(without.claims);
    const [q] = readRecord(recordFile);
    expect(q).toMatchObject({
      type: 'question',
      library: 'Work',
      question: 'How many days of annual leave?',
      outcome: 'answer',
      answer: withRecord.text,
      cited: [{ file: 'handbook.pdf', section: 'Annual leave', page: 2 }],
      starred: withRecord.claims.filter((c) => c.unsupported).length,
      switches: { namedFiles: { fired: false }, questionRewrite: { fired: false } },
    });
    expect(q!.type === 'question' && q.starred).toBeGreaterThan(0);
    expect(q!.type === 'question' && q.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failed question as an error', async () => {
    const { build, recordFile } = setup();
    await expect(service(null, (r) => build.onAnswered(r)).askOnce('Anything?')).rejects.toThrow(/not ready/);
    expect(readRecord(recordFile)).toMatchObject([
      { type: 'question', outcome: 'error', error: 'The library is not ready yet. Try again in a moment.' },
    ]);
  });

  it('records a question a newer one cancelled', async () => {
    const { build, recordFile } = setup();
    let release: () => void = () => {};
    const slow = pipeline();
    const gate = new Promise<void>((r) => (release = r));
    const deps: PipelineDeps = { ...slow, vectorSearch: async (...a) => (await gate, slow.vectorSearch(...a)) };
    const s = service(deps, (r) => build.onAnswered(r));
    const done: string[] = [];
    s.ask('first question', (e) => e.type === 'done' && done.push('first'));
    s.ask('second question', (e) => e.type === 'done' && done.push('second'));
    release();
    await expect.poll(() => readRecord(recordFile).length).toBe(2);
    const lines = readRecord(recordFile).map((l) => l.type === 'question' && [l.question, l.outcome]);
    expect(lines).toContainEqual(['first question', 'cancelled']);
    expect(lines).toContainEqual(['second question', 'answer']);
    expect(done).toEqual(['second']);
  });

  it('never lets a failing record stop an answer', async () => {
    const answer = await service(pipeline(), () => {
      throw new Error('disk full');
    }).askOnce('How many days of annual leave?');
    expect(answer.cited.length).toBeGreaterThan(0);
  });
});
