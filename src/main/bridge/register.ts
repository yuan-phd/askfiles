import { CHANNELS, type BridgeHandlers } from './contract.js';

/** The parts of ipcMain the bridge uses, so tests can pass a fake. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: { returnValue?: unknown }, ...args: unknown[]) => void): void;
}

/** Request channels answered with ipcMain.handle, mapped to their handler. */
const INVOKE: Record<string, keyof BridgeHandlers> = {
  [CHANNELS.setupReplay]: 'setupReplay',
  [CHANNELS.setupStart]: 'setupStart',
  [CHANNELS.setupRetry]: 'setupRetry',
  [CHANNELS.setupChooseFolder]: 'setupChooseFolder',
  [CHANNELS.modelsList]: 'modelsList',
  [CHANNELS.modelsPull]: 'modelsPull',
  [CHANNELS.modelsRemove]: 'modelsRemove',
  [CHANNELS.modelsSwitchChat]: 'modelsSwitchChat',
  [CHANNELS.watcherStatus]: 'watcherStatus',
  [CHANNELS.libraryResolveSources]: 'libraryResolveSources',
  [CHANNELS.libraryOpenOriginal]: 'libraryOpenOriginal',
  [CHANNELS.browseDocuments]: 'browseDocuments',
  [CHANNELS.browseDocument]: 'browseDocument',
  [CHANNELS.browseHeadings]: 'browseHeadings',
  [CHANNELS.browseSearch]: 'browseSearch',
  [CHANNELS.appInfo]: 'appInfo',
};

/** Every channel the main process listens on, for the contract test. */
export const REQUEST_CHANNELS: readonly string[] = [
  ...Object.keys(INVOKE),
  CHANNELS.shellConfig,
  CHANNELS.appPageReady,
];

/** Longest keyword query and heading key a page may send. */
const MAX_QUERY = 500;

const str = (v: unknown, max = MAX_QUERY): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/**
 * Wires the preload's requests to the handlers. Handlers are looked up at call time, so the
 * object can change what it does as the app moves from setup to search. Arguments come from a
 * page, so the string ones are checked here before any handler sees them.
 */
export function registerBridge(ipc: IpcMainLike, h: BridgeHandlers): void {
  const tagArg = (args: unknown[]): string => {
    const tag = args[0];
    if (typeof tag !== 'string' || tag.trim() === '') throw new Error('a model name is required');
    return tag.trim();
  };
  for (const [channel, name] of Object.entries(INVOKE)) {
    ipc.handle(channel, async (_event, ...args) => {
      switch (name) {
        case 'modelsPull':
        case 'modelsRemove':
        case 'modelsSwitchChat':
          return h[name](tagArg(args));
        case 'libraryResolveSources':
          return h.libraryResolveSources(Array.isArray(args[0]) ? args[0] : []);
        case 'libraryOpenOriginal':
          return h.libraryOpenOriginal(args[0] && typeof args[0] === 'object' ? args[0] : {});
        case 'browseDocument': {
          const ref = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
          return h.browseDocument({ id: str(ref.id), url: str(ref.url, 4096), title: str(ref.title, 1024) });
        }
        case 'browseHeadings':
          return h.browseHeadings(str(args[0]) || null);
        case 'browseSearch':
          return h.browseSearch(str(args[0]) ?? '');
        default:
          return (h[name] as () => unknown)();
      }
    });
  }
  ipc.on(CHANNELS.shellConfig, (event) => {
    // A sync request blocks the page until returnValue is set, so a failure still answers.
    try {
      event.returnValue = h.shellConfig();
    } catch {
      event.returnValue = { baseUrl: null, apiKey: null, workspace: null, folder: null };
    }
  });
  ipc.on(CHANNELS.appPageReady, (_event, info) => {
    if (info && typeof info === 'object' && typeof (info as { page?: unknown }).page === 'string') {
      h.appPageReady(info as { page: string });
    }
  });
}
