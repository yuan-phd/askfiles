import { app, BrowserWindow, ipcMain, Menu, protocol } from 'electron';
import path from 'node:path';
import { AppController } from './app.js';
import { messagePage, STARTING_PAGE } from './message-page.js';
import { APP_ORIGIN, APP_SCHEME, appProtocolHandler, pageUrl, type PageName } from './app-protocol.js';
import { upstreamUiEnabled, WINDOW_TITLE } from './app-mode.js';
import type { BridgeHandlers } from './bridge/contract.js';
import { registerBridge } from './bridge/register.js';
import { createLogger, resolveLogDir, resolvePort, PORT_ENV, CONFIG_ENV } from './config.js';

// Must run before the app is ready. standard and secure give the pages a real origin and a secure
// context; supportFetchAPI lets them fetch their own files (the about page reads the notices).
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/**
 * Handlers for a developer run against a server started by hand (ASKFILES_PORT or the config
 * file): the Ask page talks to that server and makes its own key; no setup, no watcher.
 */
function externalHandlers(baseUrl: string | null, log: (m: string) => void): BridgeHandlers {
  const unavailable = async (): Promise<never> => {
    throw new Error('not available when AskFiles connects to an external server');
  };
  return {
    shellConfig: () => ({ baseUrl, apiKey: null, workspace: null, folder: null }),
    setupReplay: () => [],
    setupStart: unavailable,
    setupRetry: unavailable,
    setupChooseFolder: unavailable,
    modelsList: unavailable,
    modelsPull: unavailable,
    modelsRemove: unavailable,
    modelsSwitchChat: unavailable,
    watcherStatus: () => null,
    libraryResolveSources: (sources) => sources,
    libraryOpenOriginal: async () => false,
    browseDocuments: () => [],
    browseDocument: () => null,
    browseHeadings: () => [],
    browseSearch: (query) => ({ query, terms: [], total: 0, groups: [], truncated: false }),
    answerAsk: () => {
      throw new Error('answers need the AskFiles library, which an external server does not have');
    },
    answerCancel: () => {},
    answerDeveloper: () => ({ enabled: false, overrides: {}, trace: null }),
    answerSetOverrides: () => {
      throw new Error('not available when AskFiles connects to an external server');
    },
    answerSaveCase: () => {
      throw new Error('not available when AskFiles connects to an external server');
    },
    appInfo: () => ({ name: 'AskFiles', version: app.getVersion() }),
    appPageReady: (info) => log(`page ready ${info.page} connected=${info.connected ?? '-'}`),
  };
}

function main(): void {
  const log = createLogger(resolveLogDir(process.env, app.getPath('logs')), 'main');
  log(`starting version ${app.getVersion()} pid ${process.pid}`);

  let external: string | null = null;
  let configError: string | null = null;
  try {
    const resolved = resolvePort({
      env: process.env,
      defaultConfigPath: path.join(app.getPath('userData'), 'config.json'),
    });
    if (resolved) {
      external = `http://127.0.0.1:${resolved.port}`;
      log(`server port ${resolved.port} from ${resolved.source}`);
    }
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    log(`config error: ${configError}`);
  }

  app.on('window-all-closed', () => {
    log('all windows closed, quitting');
    app.quit();
  });

  void app.whenReady().then(() => {
    const appPath = app.getAppPath();
    protocol.handle(
      APP_SCHEME,
      appProtocolHandler({
        rendererDir: path.join(appPath, 'src', 'renderer'),
        noticesFile: path.join(appPath, 'THIRD-PARTY-NOTICES'),
      }),
    );

    let controller: AppController | null = null;
    // The window shows the AskFiles pages; the upstream interface only behind the developer switch.
    const allowedOrigin = (origin: string): boolean =>
      origin === APP_ORIGIN ||
      (upstreamUiEnabled(process.env) && origin === (external ?? controller?.upstreamOrigin() ?? null));

    const windows = new Map<string, BrowserWindow>();
    const createWindow = (key: string, o: { width: number; height: number }): BrowserWindow => {
      const win = new BrowserWindow({
        ...o,
        title: WINDOW_TITLE,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.on('page-title-updated', (event) => event.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => {
        if (!URL.canParse(url) || !allowedOrigin(new URL(url).origin)) {
          event.preventDefault();
          log(`blocked navigation to ${url}`);
        }
      });
      win.webContents.on('did-fail-load', (_event, code, description, url) => {
        log(`load failed ${code} ${description} for ${url}`);
      });
      win.on('closed', () => windows.delete(key));
      windows.set(key, win);
      return win;
    };
    const openPage = (page: PageName, size: { width: number; height: number }) => {
      const open = windows.get(page);
      if (open) return open.focus();
      void createWindow(page, size).loadURL(pageUrl(page));
    };
    const broadcast = (channel: string, payload: unknown) => {
      for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
    };

    const win = createWindow('main', { width: 1200, height: 800 });
    let handlers: BridgeHandlers;
    if (configError) {
      handlers = externalHandlers(null, log);
      void win.loadURL(messagePage('No server to connect to.', configError));
    } else if (external) {
      handlers = externalHandlers(external, log);
      const target = upstreamUiEnabled(process.env) ? external + '/' : pageUrl('ask');
      log(`opening ${target}`);
      void win.loadURL(target);
    } else if (app.isPackaged) {
      controller = new AppController({ win, log, env: process.env, broadcast });
      handlers = controller;
      void win.loadURL(STARTING_PAGE);
      void controller.run();
    } else {
      handlers = externalHandlers(null, log);
      log('no server port configured');
      void win.loadURL(
        messagePage(
          'No server to connect to.',
          `Set ${PORT_ENV}, or write {"port": 3001} to the file named by ${CONFIG_ENV}.`,
        ),
      );
    }
    registerBridge(ipcMain, handlers);

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'AskFiles',
          submenu: [
            { label: 'About AskFiles', click: () => openPage('about', { width: 640, height: 720 }) },
            { type: 'separator' },
            {
              label: 'Models',
              click: () => {
                // The model page edits the server settings the first run writes; not before it.
                if (controller?.setUp()) openPage('models', { width: 900, height: 640 });
              },
            },
            { type: 'separator' },
            { role: 'hide', label: 'Hide AskFiles' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: 'Quit AskFiles' },
          ],
        },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    );
  });
}

main();
