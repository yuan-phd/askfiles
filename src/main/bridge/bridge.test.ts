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
  // A dropped File carries its path only through webUtils in Electron 32 and later.
  const webUtils = {
    getPathForFile: (file: { fakePath?: string }) => {
      if (!file?.fakePath) throw new Error('not a File');
      return file.fakePath;
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
    return { contextBridge, ipcRenderer, webUtils };
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
  const snap = { state: 'idle', failedStep: null, error: null };
  const libs = { current: 'all-files', libraries: [] };
  const settings = {
    values: { answerScope: 'balanced', answerModel: 'better', contextLength: null },
    models: { faster: null, better: { choice: 'better', model: 'qwen3:4b', tierLabel: '8 GB' } },
    contextDefault: 8192,
    contextChoices: [4096, 8192, 16384],
    scopes: ['strict', 'balanced', 'broad'],
  } as const;
  const h: BridgeHandlers = {
    shellConfig: rec('shellConfig', {
      baseUrl: 'http://127.0.0.1:5000',
      apiKey: 'K',
      workspace: 'lib',
      folder: null,
      libraryId: 'all-files',
      libraryName: 'All files',
    }),
    setupReplay: rec('setupReplay', [{ type: 'setup', ...snap }]),
    setupStart: rec('setupStart', Promise.resolve(snap)) as BridgeHandlers['setupStart'],
    setupRetry: rec('setupRetry', Promise.resolve(snap)) as BridgeHandlers['setupRetry'],
    modelsList: rec('modelsList', Promise.resolve([])),
    modelsPull: rec('modelsPull', Promise.resolve()) as BridgeHandlers['modelsPull'],
    modelsRemove: rec('modelsRemove', Promise.resolve()) as BridgeHandlers['modelsRemove'],
    modelsSwitchChat: rec('modelsSwitchChat', Promise.resolve()) as BridgeHandlers['modelsSwitchChat'],
    watcherStatus: rec('watcherStatus', null),
    libraryResolveSources: rec('libraryResolveSources', [{ title: 'a.pdf', sectionTitle: 'Intro' }]),
    libraryOpenOriginal: rec('libraryOpenOriginal', Promise.resolve(true)) as BridgeHandlers['libraryOpenOriginal'],
    librariesList: rec('librariesList', libs),
    librariesSelect: rec('librariesSelect', Promise.resolve(libs)),
    librariesCreate: async (name) => {
      calls.push(['librariesCreate', name]);
      if (!name) throw new Error('A library needs a name.');
      return libs;
    },
    librariesRename: rec('librariesRename', Promise.resolve(libs)),
    librariesRemove: rec('librariesRemove', Promise.resolve(libs)),
    librariesAddFiles: rec('librariesAddFiles', Promise.resolve(null)),
    librariesAddFolder: rec('librariesAddFolder', Promise.resolve(null)),
    librariesAddPaths: rec('librariesAddPaths', Promise.resolve({ added: 1, skipped: [] })),
    librariesRemoveSource: rec('librariesRemoveSource', Promise.resolve(libs)),
    librariesReindex: rec('librariesReindex', Promise.resolve(libs)),
    settingsGet: rec('settingsGet', settings) as unknown as BridgeHandlers['settingsGet'],
    settingsSet: rec('settingsSet', Promise.resolve(settings)) as unknown as BridgeHandlers['settingsSet'],
    developerInfo: rec('developerInfo', {}) as unknown as BridgeHandlers['developerInfo'],
    developerOpenModels: rec('developerOpenModels', Promise.resolve()) as BridgeHandlers['developerOpenModels'],
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
        'askfiles.developer.info',
        'askfiles.developer.openModels',
        'askfiles.libraries.addFiles',
        'askfiles.libraries.addFolder',
        'askfiles.libraries.addPaths',
        'askfiles.libraries.create',
        'askfiles.libraries.list',
        'askfiles.libraries.onChange',
        'askfiles.libraries.pathForFile',
        'askfiles.libraries.reindex',
        'askfiles.libraries.remove',
        'askfiles.libraries.removeSource',
        'askfiles.libraries.rename',
        'askfiles.libraries.select',
        'askfiles.library.openOriginal',
        'askfiles.models.list',
        'askfiles.models.onProgress',
        'askfiles.models.pull',
        'askfiles.models.remove',
        'askfiles.models.switchChat',
        'askfiles.settings.get',
        'askfiles.settings.set',
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
    await a.models.list();
    await a.models.pull('qwen3:8b');
    a.models.onProgress(() => {});
    await a.models.remove('qwen3:4b');
    await a.models.switchChat('qwen3:4b');
    await a.watcher.status();
    a.watcher.onStatus(() => {});
    await a.library.resolveSources([]);
    await a.library.openOriginal({ title: 'a.pdf' });
    await a.libraries.list();
    a.libraries.onChange(() => {});
    await a.libraries.select('lib-1');
    await a.libraries.create('Work');
    await a.libraries.rename('lib-1', 'Work 2');
    await a.libraries.remove('lib-1');
    await a.libraries.addFiles();
    await a.libraries.addFolder();
    await a.libraries.addPaths(['/a.pdf']);
    await a.libraries.removeSource('folder-1');
    await a.libraries.reindex();
    await a.settings.get();
    await a.settings.set({ answerScope: 'strict' });
    await a.developer.info();
    await a.developer.openModels();
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
    expect(shell).toMatchObject({
      baseUrl: 'http://127.0.0.1:5000',
      apiKey: 'K',
      workspace: 'lib',
      libraryId: 'all-files',
      libraryName: 'All files',
    });

    await a.models.pull('qwen3:8b');
    expect(t.calls).toContainEqual(['modelsPull', 'qwen3:8b']);
    await expect(a.models.pull('  ')).rejects.toThrow(/^a model name is required$/);
    await expect(a.libraries.create('')).rejects.toThrow(/^A library needs a name\.$/);

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

  it('checks the library and settings arguments a page sends', async () => {
    const t = recordingHandlers();
    const a = loadPreload(t.h).exposed.askfiles as unknown as import('./contract.js').AskfilesBridge;
    await expect(a.libraries.select('')).rejects.toThrow(/^a library or source id is required$/);
    await expect(a.libraries.removeSource('x'.repeat(201))).rejects.toThrow(/id is required/);
    await a.libraries.rename('lib-1', 'n'.repeat(300));
    expect(t.calls).toContainEqual(['librariesRename', 'lib-1', 'n'.repeat(200)]);
    await a.libraries.addPaths(['/a.pdf', '', 'x'.repeat(5000), '/b'] as string[]);
    expect(t.calls).toContainEqual(['librariesAddPaths', ['/a.pdf', '/b']]);
    await a.settings.set(null as never);
    expect(t.calls).toContainEqual(['settingsSet', {}]);
    await a.settings.set({ answerScope: 'broad' });
    expect(t.calls).toContainEqual(['settingsSet', { answerScope: 'broad' }]);
    // A dropped file's path comes from webUtils in the preload; anything else gives none.
    expect(a.libraries.pathForFile({ fakePath: '/Users/u/a.pdf' } as never)).toBe('/Users/u/a.pdf');
    expect(a.libraries.pathForFile({} as never)).toBe('');
  });

  it('replays setup state to a late subscriber, delivers live events, and unsubscribes', async () => {
    const t = recordingHandlers();
    const p = loadPreload(t.h);
    const a = p.exposed.askfiles as unknown as import('./contract.js').AskfilesBridge;
    const seen: unknown[] = [];
    const off = a.setup.onEvent((e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ type: 'setup', state: 'idle', failedStep: null, error: null }]);
    p.send(CHANNELS.setupEvent, { type: 'setup', state: 'models' });
    off();
    p.send(CHANNELS.setupEvent, { type: 'setup', state: 'createLibrary' });
    expect(seen).toHaveLength(2);

    const statuses: unknown[] = [];
    a.watcher.onStatus((s) => statuses.push(s));
    p.send(CHANNELS.watcherStatusEvent, { state: 'idle', indexed: 2 });
    expect(statuses).toEqual([{ state: 'idle', indexed: 2 }]);

    const views: unknown[] = [];
    a.libraries.onChange((v) => views.push(v));
    p.send(CHANNELS.librariesEvent, { current: 'lib-1', libraries: [] });
    expect(views).toEqual([{ current: 'lib-1', libraries: [] }]);
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
    expect(shell).toMatchObject({ baseUrl: null, apiKey: null, workspace: null, libraryId: null, libraryName: null });
  });
});
