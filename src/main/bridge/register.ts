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
  [CHANNELS.answerAsk]: 'answerAsk',
  [CHANNELS.answerCancel]: 'answerCancel',
  [CHANNELS.answerDeveloper]: 'answerDeveloper',
  [CHANNELS.answerSetOverrides]: 'answerSetOverrides',
  [CHANNELS.answerSaveCase]: 'answerSaveCase',
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
/** Longest question a page may send. */
const MAX_QUESTION = 4000;

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
        case 'answerAsk': {
          const question = str(args[0], MAX_QUESTION)?.trim();
          if (!question) throw new Error('a question is required');
          // Events go to the page that asked, not to every window.
          const sender = (_event as { sender?: { send(channel: string, payload: unknown): void } } | null)?.sender;
          return h.answerAsk(question, (e) => sender?.send(CHANNELS.answerEvent, e));
        }
        case 'answerCancel':
          return h.answerCancel(str(args[0], 100) ?? '');
        case 'answerSetOverrides': {
          const o = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
          const num = (v: unknown) => (typeof v === 'number' ? v : null);
          return h.answerSetOverrides({ sectionCount: num(o.sectionCount), rerankFloor: num(o.rerankFloor) });
        }
        case 'answerSaveCase': {
          const c = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
          const question = str(c.question, MAX_QUESTION)?.trim();
          const file = str(c.file, 1024);
          const sectionPath = Array.isArray(c.path) ? c.path.filter((t) => typeof t === 'string').slice(0, 20) : [];
          if (!question || !file || !sectionPath.length)
            throw new Error('a question, a file and a section path are required');
          const page = typeof c.pageStart === 'number' && c.pageStart > 0 ? c.pageStart : null;
          return h.answerSaveCase({ question, file, path: sectionPath as string[], pageStart: page });
        }
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
