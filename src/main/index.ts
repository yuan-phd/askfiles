import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from 'electron';
import path from 'node:path';
import { AppController } from './app.js';
import { messagePage, STARTING_PAGE } from './message-page.js';
import { APP_ORIGIN, APP_SCHEME, appProtocolHandler, pageUrl, type PageName } from './app-protocol.js';
import { devBackend, developerEnabled, upstreamUiEnabled, WINDOW_TITLE } from './app-mode.js';
import type { BridgeHandlers } from './bridge/contract.js';
import { registerBridge } from './bridge/register.js';
import { createLogger, resolveLogDir, resolvePort, PORT_ENV, CONFIG_ENV } from './config.js';
import { appDirs } from './platform.js';
import { loadTestBuild, removeTestRecord, type TestBuild } from './test-build.js';

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
    shellConfig: () => ({
      baseUrl,
      apiKey: null,
      workspace: null,
      folder: null,
      libraryId: null,
      libraryName: null,
      askNotice: null,
    }),
    setupReplay: () => [],
    setupStart: unavailable,
    setupRetry: unavailable,
    modelsList: unavailable,
    modelsPull: unavailable,
    modelsRemove: unavailable,
    modelsSwitchChat: unavailable,
    watcherStatus: () => null,
    libraryResolveSources: (sources) => sources,
    libraryOpenOriginal: async () => false,
    librariesList: () => ({ current: '', libraries: [] }),
    librariesSelect: unavailable,
    librariesCreate: unavailable,
    librariesRename: unavailable,
    librariesRemove: unavailable,
    librariesAddFiles: unavailable,
    librariesAddFolder: unavailable,
    librariesAddPaths: unavailable,
    librariesRemoveSource: unavailable,
    librariesReindex: unavailable,
    settingsGet: () => {
      throw new Error('not available when AskFiles connects to an external server');
    },
    settingsSet: unavailable,
    developerInfo: () => {
      throw new Error('not available when AskFiles connects to an external server');
    },
    developerOpenModels: unavailable,
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
    graphData: () => null,
    graphProfiles: () => [],
    graphSetType: unavailable,
    graphAnswerFamily: unavailable,
    librariesSetProfile: unavailable,
    summariesStatus: () => null,
    summariesPause: () => null,
    summariesResume: () => null,
    summariesDocument: () => null,
    summariesRequestSections: () => null,
    summariesSetLibrary: unavailable,
    summariesOpenExport: async () => false,
  };
}

function main(): void {
  const dev = devBackend(process.env, app.getAppPath());
  // Windows keeps data and logs in %LOCALAPPDATA%\AskFiles (platform.ts); set before anything reads them.
  const dirs = appDirs(process.platform, process.env, { dev: !!dev });
  if (dirs) {
    app.setPath('userData', dirs.userData);
    app.setPath('logs', dirs.logs);
  }
  // Its own data directory, so a dev run never touches the installed app's library or models.
  else if (dev) app.setPath('userData', path.join(app.getPath('appData'), 'AskFiles-dev'));
  // Only a test build has this module (scripts/build-main.mjs --flavour test).
  const testModule = loadTestBuild(__dirname);
  // The packaged test build is named AskFiles Test but keeps the release build's data directory and
  // logs, so libraries and models carry over when the release build is installed over it. Windows
  // names its folders itself (platform.ts); a run from source keeps its own.
  if (testModule && !dirs && !dev && app.isPackaged) {
    app.setPath('userData', path.join(app.getPath('appData'), 'AskFiles'));
    if (process.platform === 'darwin')
      app.setPath('logs', path.join(app.getPath('home'), 'Library', 'Logs', 'AskFiles'));
  }
  const log = createLogger(resolveLogDir(process.env, app.getPath('logs')), 'main');
  log(`starting version ${app.getVersion()} pid ${process.pid}${testModule ? ' (test build)' : ''}`);
  if (dev) log(`dev run: backend from ${dev.resourcesPath}, node ${dev.nodePath}, ollama on ${dev.externalOllamaPort}`);
  if (!testModule) removeTestRecord(app.getPath('userData'), log);
  // Set once the bridge handlers exist; the record names the current library.
  let currentHandlers: BridgeHandlers | null = null;
  const testBuild: TestBuild | null = testModule
    ? testModule.createTestBuild({
        dataDir: app.getPath('userData'),
        desktopDir: app.getPath('desktop'),
        version: app.getVersion(),
        platform: process.platform,
        log,
        showItemInFolder: (file) => shell.showItemInFolder(file),
        libraryName: () => {
          try {
            return currentHandlers?.shellConfig().libraryName ?? null;
          } catch {
            return null;
          }
        },
      })
    : null;
  const windowTitle = WINDOW_TITLE + (testBuild?.titleSuffix ?? '');

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
        appDir: appPath,
        ...(testBuild ? { extraFile: (p: string) => testBuild.resolveAsset(p) } : {}),
      }),
    );
    if (testBuild) session.defaultSession.registerPreloadScript({ type: 'frame', filePath: testBuild.preloadFile });

    let controller: AppController | null = null;
    // The window shows the AskFiles pages; the upstream interface only behind the developer switch.
    const allowedOrigin = (origin: string): boolean =>
      origin === APP_ORIGIN ||
      (upstreamUiEnabled(process.env) && origin === (external ?? controller?.upstreamOrigin() ?? null));

    const windows = new Map<string, BrowserWindow>();
    const createWindow = (key: string, o: { width: number; height: number }): BrowserWindow => {
      const win = new BrowserWindow({
        ...o,
        title: windowTitle,
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
    } else if (app.isPackaged || dev) {
      controller = new AppController({
        win,
        log,
        env: process.env,
        dev,
        broadcast,
        openModelsWindow: () => openPage('models', { width: 900, height: 640 }),
        ...(testBuild ? { onAnswered: (run) => testBuild.onAnswered(run) } : {}),
      });
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
    if (testBuild) {
      handlers = testBuild.wrapHandlers(handlers);
      testBuild.registerIpc(ipcMain);
    }
    currentHandlers = handlers;
    registerBridge(ipcMain, handlers);

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'AskFiles',
          submenu: [
            { label: 'About AskFiles', click: () => openPage('about', { width: 640, height: 720 }) },
            { type: 'separator' },
            {
              label: 'Settings...',
              accelerator: 'CommandOrControl+,',
              click: () => {
                // Settings change what the first run set up; not before it.
                if (controller?.setUp()) openPage('settings', { width: 720, height: 640 });
              },
            },
            ...(developerEnabled(process.env)
              ? [{ label: 'Developer', click: () => openPage('developer', { width: 900, height: 720 }) }]
              : []),
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
