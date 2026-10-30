import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CHANNELS, EVENT_CHANNELS, type BridgeHandlers } from './contract.js';
import { registerBridge, REQUEST_CHANNELS, type IpcMainLike } from './register.js';

const RENDERER = path.resolve(import.meta.dirname, '../../renderer');
const PRELOAD = path.resolve(import.meta.dirname, '../preload.ts');

type Listener = (event: unknown, ...args: unknown[]) => unknown;

/**
 * Loads the preload the way the sandboxed renderer does: compiled with the project's settings and
 * run as the body of a function that gets require and a few globals, but no exports or module.
 * ipcRenderer is wired to registerBridge through fake ipcMain objects, so every call crosses the
 * same channel names it would in the app.
 */
function loadPreload(handlers: BridgeHandlers) {
  const handle = new Map<string, Listener>();
  const on = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handle.set(channel, listener),
    on: (channel, listener) => void on.set(channel, listener as Listener),
  };
  registerBridge(ipcMain, handlers);

  const used = new Set<string>();
  const subscribed = new Map<string, Set<Listener>>();
  const toPage = (channel: string, payload: unknown) => {
    for (const l of subscribed.get(channel) ?? []) l({}, structuredClone(payload));
  };
  const ipcRenderer = {
    async invoke(channel: string, ...args: unknown[]) {
      used.add(channel);
      const h = handle.get(channel);
      if (!h) throw new Error(`No handler registered for '${channel}'`);
      try {
        // Arguments and results are copied across the bridge, as structured clone does.
        // The sender is the page; the answer events of a question go back to it only.
        return structuredClone(await h({ sender: { send: toPage } }, ...structuredClone(args)));
      } catch (e) {
        // Electron's wording for a handler that threw.
        throw new Error(`Error invoking remote method '${channel}': ${String(e)}`, { cause: e });
      }
    },
    sendSync(channel: string, ...args: unknown[]) {
      used.add(channel);
      const event: { returnValue?: unknown } = {};
      on.get(channel)?.(event, ...args);
      return event.returnValue;
    },
    send(channel: string, ...args: unknown[]) {
      used.add(channel);
      on.get(channel)?.({}, ...structuredClone(args));
    },
    on(channel: string, listener: Listener) {
      used.add(channel);
      if (!subscribed.has(channel)) subscribed.set(channel, new Set());
      subscribed.get(channel)!.add(listener);
    },
    removeListener(channel: string, listener: Listener) {
      subscribed.get(channel)?.delete(listener);
    },
  };
  const exposed: Record<string, Record<string, unknown>> = {};
  const contextBridge = {
    exposeInMainWorld(key: string, api: Record<string, unknown>) {
      exposed[key] = api;
    },
  };

  const source = fs.readFileSync(PRELOAD, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
    },
  });
  const requireStub = (name: string) => {
    if (name !== 'electron') throw new Error(`a sandboxed preload cannot require ${name}`);
    return { contextBridge, ipcRenderer };
  };
  new Function('require', 'process', 'Buffer', 'global', 'setImmediate', 'clearImmediate', outputText)(
    requireStub,
    {},
    undefined,
    {},
    setImmediate,
    clearImmediate,
  );
  /** Main pushing an event to the page. */
  const send = toPage;
  return { exposed, used, subscribed, send, outputText };
}

/** Handlers that record each call and answer with something recognisable. */
function recordingHandlers() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    <T>(name: string, result: T) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const snap = { state: 'idle', failedStep: null, error: null, folder: null };
  const h: BridgeHandlers = {
    shellConfig: rec('shellConfig', {
      baseUrl: 'http://127.0.0.1:5000',
      apiKey: 'K',
      workspace: 'lib',
      folder: '/Docs',
    }),
    setupReplay: rec('setupReplay', [{ type: 'setup', ...snap }]),
    setupStart: rec('setupStart', Promise.resolve(snap)) as BridgeHandlers['setupStart'],
    setupRetry: rec('setupRetry', Promise.resolve(snap)) as BridgeHandlers['setupRetry'],
    setupChooseFolder: async () => {
      calls.push(['setupChooseFolder']);
      throw new Error('/x is not a folder');
    },
    modelsList: rec('modelsList', Promise.resolve([])),
    modelsPull: rec('modelsPull', Promise.resolve()) as BridgeHandlers['modelsPull'],
    modelsRemove: rec('modelsRemove', Promise.resolve()) as BridgeHandlers['modelsRemove'],
    modelsSwitchChat: rec('modelsSwitchChat', Promise.resolve()) as BridgeHandlers['modelsSwitchChat'],
    watcherStatus: rec('watcherStatus', null),
    libraryResolveSources: rec('libraryResolveSources', [{ title: 'a.pdf', sectionTitle: 'Intro' }]),
    libraryOpenOriginal: rec('libraryOpenOriginal', Promise.resolve(true)) as BridgeHandlers['libraryOpenOriginal'],
    browseDocuments: rec('browseDocuments', []),
    browseDocument: rec('browseDocument', null),
    browseHeadings: rec('browseHeadings', [{ key: 'scope', label: 'Scope', documents: 2, entries: [] }]),
    browseSearch: rec('browseSearch', { query: 'q', terms: ['q'], total: 0, groups: [], truncated: false }),
    answerAsk: (question: string, emit: (e: never) => void) => {
      calls.push(['answerAsk', question]);
      emit({ id: 'r1', type: 'stage', stage: 'retrieving' } as never);
      return { id: 'r1' };
    },
    answerCancel: rec('answerCancel', undefined) as BridgeHandlers['answerCancel'],
    answerDeveloper: rec('answerDeveloper', { enabled: true, overrides: {}, trace: null }),
    answerSetOverrides: rec('answerSetOverrides', { sectionCount: 2, rerankFloor: null }),
    answerSaveCase: rec('answerSaveCase', { id: 'case-1', file: '/d/q.csv' }),
    appInfo: rec('appInfo', { name: 'AskFiles', version: '0.1.0' }),
    appPageReady: rec('appPageReady', undefined) as BridgeHandlers['appPageReady'],
  };
  return { h, calls };
}

/**
 * What the pages call, read from their sources: window.askfiles?.ns?.fn(...), a variable bound
 * to window.askfiles?.ns and then called as v.fn(...), and window.shellConfig.fn / ?.fn.
 */
function pageCalls(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (file: string, call: string) => {
    if (!out.has(call)) out.set(call, new Set());
    out.get(call)!.add(path.relative(RENDERER, file));
  };
  const files = fs
    .readdirSync(RENDERER, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => path.join(RENDERER, f));
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/window\.askfiles\?\.(\w+)\?\.(\w+)/g)) add(file, `askfiles.${m[1]}.${m[2]}`);
    for (const m of src.matchAll(/(\w+) = window\.askfiles\?\.(\w+)\b(?!\?\.)/g)) {
      for (const c of src.matchAll(new RegExp(`\\b${m[1]}\\s*\\.(\\w+)\\(`, 'g')))
        add(file, `askfiles.${m[2]}.${c[1]}`);
    }
    for (const m of src.matchAll(/window\.shellConfig\??\.(\w+)/g)) add(file, `shellConfig.${m[1]}`);
  }
  return out;
}

describe('preload bridge', () => {
  it('compiles to a script that needs nothing but require', () => {
    const { outputText, exposed } = loadPreload(recordingHandlers().h);
    expect(outputText).not.toMatch(/\bexports\b|\bmodule\./);
    expect(Object.keys(exposed).sort()).toEqual(['askfiles', 'shellConfig']);
  });

  it('exposes every function the pages call', () => {
    const { exposed } = loadPreload(recordingHandlers().h);
    const calls = pageCalls();
    // The scan must see the pages; an empty result would pass vacuously.
    expect([...calls.keys()].sort()).toEqual(
      [
        'askfiles.answer.ask',
        'askfiles.answer.cancel',
        'askfiles.answer.developer',
        'askfiles.answer.onEvent',
        'askfiles.answer.saveCase',
        'askfiles.answer.setOverrides',
        'askfiles.app.info',
        'askfiles.app.pageReady',
        'askfiles.browse.document',
        'askfiles.browse.documents',
        'askfiles.browse.headings',
        'askfiles.browse.search',
        'askfiles.library.openOriginal',
        'askfiles.models.list',
        'askfiles.models.onProgress',
        'askfiles.models.pull',
        'askfiles.models.remove',
        'askfiles.models.switchChat',
        'askfiles.setup.chooseFolder',
        'askfiles.setup.onEvent',
        'askfiles.setup.retry',
        'askfiles.setup.start',
        'askfiles.watcher.onStatus',
        'askfiles.watcher.status',
        'shellConfig.openSource',
      ].sort(),
    );
    for (const call of calls.keys()) {
      const parts = call.split('.');
      const target =
        parts[0] === 'askfiles'
          ? (exposed.askfiles![parts[1]!] as Record<string, unknown>)?.[parts[2]!]
          : exposed.shellConfig![parts[1]!];
      expect(typeof target, `${call} used by ${[...calls.get(call)!].join(', ')}`).toBe('function');
    }
  });

  it('uses exactly the channels the main process registers', async () => {
    const t = recordingHandlers();
    const p = loadPreload(t.h);
    const a = p.exposed.askfiles as unknown as import('./contract.js').AskfilesBridge;
    a.setup.onEvent(() => {});
    await a.setup.start();
    await a.setup.retry();
    await a.setup.chooseFolder().catch(() => {});
    await a.models.list();
    await a.models.pull('qwen3:8b');
    a.models.onProgress(() => {});
    await a.models.remove('qwen3:4b');
    await a.models.switchChat('qwen3:4b');
    await a.watcher.status();
    a.watcher.onStatus(() => {});
    await a.library.resolveSources([]);
    await a.library.openOriginal({ title: 'a.pdf' });
    await a.browse.documents();
    await a.browse.document({ id: 'abc' });
    await a.browse.headings();
    await a.browse.search('leave');
    a.answer.onEvent(() => {});
    await a.answer.ask('How long is leave?');
    await a.answer.cancel('r1');
    await a.answer.developer();
    await a.answer.setOverrides({ sectionCount: 2 });
    await a.answer.saveCase({ question: 'q', file: 'a.pdf', path: ['Leave'], pageStart: 3 });
    await a.app.info();
    a.app.pageReady({ page: 'ask' });
    const all = new Set([...REQUEST_CHANNELS, ...EVENT_CHANNELS]);
    expect([...p.used].sort()).toEqual([...all].sort());
    expect(new Set(Object.values(CHANNELS))).toEqual(all);
    expect([...p.subscribed.keys()].sort()).toEqual([...EVENT_CHANNELS].sort());
  });

  it('passes arguments and results through and keeps only the message of an error', async () => {
    const t = recordingHandlers();
    const { exposed } = loadPreload(t.h);
    const a = exposed.askfiles as unknown as import('./contract.js').AskfilesBridge;
    const shell = exposed.shellConfig as unknown as import('./contract.js').ShellConfig;
    expect(shell).toMatchObject({ baseUrl: 'http://127.0.0.1:5000', apiKey: 'K', workspace: 'lib', folder: '/Docs' });

    await a.models.pull('qwen3:8b');
    expect(t.calls).toContainEqual(['modelsPull', 'qwen3:8b']);
    await expect(a.models.pull('  ')).rejects.toThrow(/^a model name is required$/);
    await expect(a.setup.chooseFolder()).rejects.toThrow(/^\/x is not a folder$/);

    expect(await shell.resolveSources([{ title: 'a.pdf', text: 'x' }])).toEqual([
      { title: 'a.pdf', sectionTitle: 'Intro' },
    ]);
    expect(t.calls).toContainEqual(['libraryResolveSources', [{ title: 'a.pdf', text: 'x' }]]);
    expect(await shell.openSource({ title: 'a.pdf', url: 'file:///Docs/a.pdf' })).toBe(true);
    expect(t.calls).toContainEqual(['libraryOpenOriginal', { title: 'a.pdf', url: 'file:///Docs/a.pdf' }]);
    a.app.pageReady({ page: 'search', connected: true, documents: 3 });
    expect(t.calls).toContainEqual(['appPageReady', { page: 'search', connected: true, documents: 3 }]);
  });

  it('checks the browse arguments a page sends before the handlers see them', async () => {
    const t = recordingHandlers();
    const a = loadPreload(t.h).exposed.askfiles as unknown as import('./contract.js').AskfilesBridge;
    expect(await a.browse.documents()).toEqual([]);
    expect(await a.browse.document({ url: 'file:///Docs/a.pdf', title: 'a.pdf' })).toBeNull();
    expect(t.calls).toContainEqual(['browseDocument', { id: null, url: 'file:///Docs/a.pdf', title: 'a.pdf' }]);
    await a.browse.document(null as never);
    expect(t.calls).toContainEqual(['browseDocument', { id: null, url: null, title: null }]);
    await a.browse.document({ id: 42 } as never);
    expect(t.calls.filter((c) => c[0] === 'browseDocument').pop()).toEqual([
      'browseDocument',
      { id: null, url: null, title: null },
    ]);

    expect(await a.browse.headings()).toEqual([{ key: 'scope', label: 'Scope', documents: 2, entries: [] }]);
    await a.browse.headings('scope');
    expect(t.calls.filter((c) => c[0] === 'browseHeadings')).toEqual([
      ['browseHeadings', null],
      ['browseHeadings', 'scope'],
    ]);

    await a.browse.search('年假 leave');
    await a.browse.search('x'.repeat(2000));
    const searches = t.calls.filter((c) => c[0] === 'browseSearch');
    expect(searches[0]).toEqual(['browseSearch', '年假 leave']);
    expect((searches[1]![1] as string).length).toBe(500);
  });

  it('replays setup state to a late subscriber, delivers live events, and unsubscribes', async () => {
    const t = recordingHandlers();
    const p = loadPreload(t.h);
    const a = p.exposed.askfiles as unknown as import('./contract.js').AskfilesBridge;
    const seen: unknown[] = [];
    const off = a.setup.onEvent((e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ type: 'setup', state: 'idle', failedStep: null, error: null, folder: null }]);
    p.send(CHANNELS.setupEvent, { type: 'setup', state: 'models' });
    off();
    p.send(CHANNELS.setupEvent, { type: 'setup', state: 'chooseFolder' });
    expect(seen).toHaveLength(2);

    const statuses: unknown[] = [];
    a.watcher.onStatus((s) => statuses.push(s));
    p.send(CHANNELS.watcherStatusEvent, { state: 'idle', indexed: 2 });
    expect(statuses).toEqual([{ state: 'idle', indexed: 2 }]);
  });

  it('sends answer events to the asking page and checks the answer arguments', async () => {
    const t = recordingHandlers();
    const p = loadPreload(t.h);
    const a = p.exposed.askfiles as unknown as import('./contract.js').AskfilesBridge;
    const seen: unknown[] = [];
    a.answer.onEvent((e) => seen.push(e));
    expect(await a.answer.ask('  How long is leave?  ')).toEqual({ id: 'r1' });
    expect(t.calls).toContainEqual(['answerAsk', 'How long is leave?']);
    expect(seen).toEqual([{ id: 'r1', type: 'stage', stage: 'retrieving' }]);
    await expect(a.answer.ask('   ')).rejects.toThrow(/^a question is required$/);

    await a.answer.setOverrides({ sectionCount: '3', rerankFloor: 0.2 } as never);
    expect(t.calls).toContainEqual(['answerSetOverrides', { sectionCount: null, rerankFloor: 0.2 }]);
    await expect(a.answer.saveCase({ question: 'q', file: 'a.pdf', path: [], pageStart: null })).rejects.toThrow(
      /a question, a file and a section path are required/,
    );
    await a.answer.saveCase({ question: 'q', file: 'a.pdf', path: ['A', 7 as never, 'B'], pageStart: -1 });
    expect(t.calls).toContainEqual([
      'answerSaveCase',
      { question: 'q', file: 'a.pdf', path: ['A', 'B'], pageStart: null },
    ]);
  });

  it('answers the sync config request even when the handler fails', () => {
    const t = recordingHandlers();
    t.h.shellConfig = () => {
      throw new Error('no state');
    };
    const shell = loadPreload(t.h).exposed.shellConfig!;
    expect(shell).toMatchObject({ baseUrl: null, apiKey: null, workspace: null, folder: null });
  });
});
