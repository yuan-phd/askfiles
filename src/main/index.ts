import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createLogger, resolveLogDir, resolvePort, PORT_ENV, CONFIG_ENV } from './config.js';
import { startBundledBackend, STARTING_PAGE } from './app.js';

// The packaged app starts its own server (src/main/app.ts). A developer run, or a port set by hand,
// connects to a server that is already running; this page says why the window is empty.
function noServerPage(reason: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>AskFiles</title>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:2em;line-height:1.5">
<h1>AskFiles</h1><p>No server to connect to.</p><p>${reason.replace(/[<>&]/g, '')}</p>
<p>Set ${PORT_ENV}, or write {"port": 3001} to the file named by ${CONFIG_ENV}.</p></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function main(): void {
  const log = createLogger(resolveLogDir(process.env, app.getPath('logs')), 'main');
  log(`starting version ${app.getVersion()} pid ${process.pid}`);

  let target: string;
  let origin: string | null = null;
  let bundled = false;
  try {
    const resolved = resolvePort({
      env: process.env,
      defaultConfigPath: join(app.getPath('userData'), 'config.json'),
    });
    if (resolved) {
      origin = `http://127.0.0.1:${resolved.port}`;
      target = origin + '/';
      log(`server port ${resolved.port} from ${resolved.source}`);
    } else if (app.isPackaged) {
      target = STARTING_PAGE;
      bundled = true;
    } else {
      target = noServerPage('No port is configured.');
      log('no server port configured');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    target = noServerPage(message);
    log(`config error: ${message}`);
  }

  app.on('window-all-closed', () => {
    log('all windows closed, quitting');
    app.quit();
  });

  void app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'AskFiles',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // The window shows only the local server; nothing it loads may open other windows or leave 127.0.0.1.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (origin === null || !URL.canParse(url) || new URL(url).origin !== origin) {
        event.preventDefault();
        log(`blocked navigation to ${url}`);
      }
    });
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      log(`load failed ${code} ${description} for ${url}`);
    });
    log(`opening window at ${origin ?? (bundled ? 'starting page' : 'no-server page')}`);
    void win.loadURL(target);
    if (bundled) {
      startBundledBackend(log, {
        onReady: (o) => {
          origin = o;
          void win.loadURL(o + '/');
        },
        onError: (message) => void win.loadURL(noServerPage(message)),
      });
    }
  });
}

main();
