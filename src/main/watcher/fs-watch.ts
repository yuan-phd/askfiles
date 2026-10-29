import { watch } from 'chokidar';
import { isHidden } from './file-types.js';
import type { WatchFactory } from './types.js';

/**
 * chokidar 4 rather than fs.watch: recursive fs.watch on Linux is built in JavaScript on inotify
 * and has missed events in Node 20 and 22, it reports renames without telling add from unlink,
 * and it needs our own polling fallback for network volumes. chokidar 4 is about 150 KB with one
 * dependency (readdirp) and ships CommonJS, which the main process build emits.
 */
export const chokidarWatch: WatchFactory = (root, onEvent, onError) => {
  const w = watch(root, {
    ignoreInitial: true,
    // The user's folder may link anywhere on disk; only its own contents belong in the library.
    followSymlinks: false,
    ignored: (p: string) => isHidden(p, root),
  });
  w.on('add', (p) => onEvent('add', p));
  w.on('change', (p) => onEvent('change', p));
  w.on('unlink', (p) => onEvent('unlink', p));
  w.on('error', (e) => onError(e instanceof Error ? e : new Error(String(e))));
  const ready = new Promise<void>((resolve) => w.once('ready', () => resolve()));
  return { ready, close: () => w.close() };
};
