// Preload script of every AskFiles window. The windows run sandboxed with context isolation and
// without Node integration, so this file may load nothing but electron: the channel names below
// repeat CHANNELS in bridge/contract.ts (bridge.test.ts keeps the two in step). It exposes
// window.askfiles, the API the onboarding, models, search and about pages call, and
// window.shellConfig, the values the search page reads at load.
//
// The file has no import or export, so with moduleDetection legacy (tsconfig.json) tsc emits a
// plain script without the CommonJS exports line, which the sandboxed preload wrapper need not
// support. Types come through import() type queries, which emit nothing.
type AskfilesBridge = import('./bridge/contract.js').AskfilesBridge;
type ShellConfig = import('./bridge/contract.js').ShellConfig;
type ShellConfigValues = import('./bridge/contract.js').ShellConfigValues;
type IpcRendererEvent = import('electron').IpcRendererEvent;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

// ipcRenderer.invoke rejects with "Error invoking remote method '<channel>': Error: <message>";
// the pages show the message to the user, so only the message is kept.
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
  }) as Promise<T>;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const askfiles: AskfilesBridge = {
  setup: {
    onEvent(callback) {
      const off = subscribe('askfiles:setup:event', callback);
      // Events sent before this page subscribed are replayed, so a reload shows the current step.
      void invoke<Parameters<typeof callback>[0][]>('askfiles:setup:replay').then((events) => events.forEach(callback));
      return off;
    },
    start: () => invoke('askfiles:setup:start'),
    retry: () => invoke('askfiles:setup:retry'),
    chooseFolder: () => invoke('askfiles:setup:choose-folder'),
  },
  models: {
    list: () => invoke('askfiles:models:list'),
    pull: (tag) => invoke('askfiles:models:pull', String(tag)),
    onProgress: (callback) => subscribe('askfiles:models:progress', callback),
    remove: (tag) => invoke('askfiles:models:remove', String(tag)),
    switchChat: (tag) => invoke('askfiles:models:switch-chat', String(tag)),
  },
  watcher: {
    status: () => invoke('askfiles:watcher:status'),
    onStatus: (callback) => subscribe('askfiles:watcher:status-event', callback),
  },
  library: {
    resolveSources: (sources) => invoke('askfiles:library:resolve-sources', sources),
    openOriginal: (source) => invoke('askfiles:library:open-original', source),
  },
  app: {
    info: () => invoke('askfiles:app:info'),
    pageReady: (info) => ipcRenderer.send('askfiles:app:page-ready', info),
  },
};

const values = (ipcRenderer.sendSync('askfiles:shell-config') ?? {}) as Partial<ShellConfigValues>;
const shellConfig: ShellConfig = {
  baseUrl: values.baseUrl ?? null,
  apiKey: values.apiKey ?? null,
  workspace: values.workspace ?? null,
  folder: values.folder ?? null,
  resolveSources: askfiles.library.resolveSources,
  openSource: askfiles.library.openOriginal,
};

contextBridge.exposeInMainWorld('askfiles', askfiles);
contextBridge.exposeInMainWorld('shellConfig', shellConfig);
