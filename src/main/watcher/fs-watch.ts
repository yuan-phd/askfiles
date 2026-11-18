import { watch } from 'chokidar';
import { inSkippedFolder, isVenvFolder } from './file-types.js';
import { processWatchBudget, type WatchBudget } from './folder-limit.js';
import type { WatchFactory } from './types.js';

/**
 * chokidar 4 rather than fs.watch: recursive fs.watch on Linux is built in JavaScript on inotify
 * and has missed events in Node 20 and 22, it reports renames without telling add from unlink,
 * and it needs our own polling fallback for network volumes. chokidar 4 is about 150 KB with one
 * dependency (readdirp) and ships CommonJS, which the main process build emits.
 *
 * chokidar opens one fs.watch per folder (and one per file, which macOS serves through kqueue and
 * does not count against the FSEvents limit). Every folder asks budget first (folder-limit.ts): a
 * folder refused is not watched, nor anything below it, so the process never reaches the 4,096
 * folders at which every watch fails, and closing the watches stays short.
 */
export function createChokidarWatch(budget: WatchBudget): WatchFactory {
  return (root, onEvent, onError, options = {}) => {
    const { only } = options;
    const mine = new Set<string>();
    const refused = new Set<string>();
    const venv = new Map<string, boolean>();
    const w = watch(root, {
      ignoreInitial: true,
      // The user's folder may link anywhere on disk; only its own contents belong in the library.
      followSymlinks: false,
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
      ignored: (p: string, stats?: { isDirectory(): boolean }) => {
        // With only, the other files of the folder are never looked at, so a large Downloads
        // folder costs one directory watch and no stat per file.
        if (only && p !== root && !only.has(p)) return true;
        const isDir = stats?.isDirectory() ?? false;
        if (inSkippedFolder(p, root, isDir)) return true;
        // chokidar asks again with stats right before it watches a folder: decide there.
        if (!isDir) return false;
        if (p !== root) {
          let v = venv.get(p);
          if (v === undefined) venv.set(p, (v = isVenvFolder(p)));
          if (v) return true;
        }
        // The linked folder itself takes no place under the limit; the folder of added files does.
        if (budget.admit(p, mine, { counts: !(p === root && options.depth === undefined) })) return false;
        if (!refused.has(p)) {
          refused.add(p);
          options.onLimit?.(refused.size);
        }
        return true;
      },
    });
    w.on('add', (p) => onEvent('add', p));
    w.on('change', (p) => onEvent('change', p));
    w.on('unlink', (p) => onEvent('unlink', p));
    w.on('error', (e) => onError(e instanceof Error ? e : new Error(String(e))));
    const ready = new Promise<void>((resolve) => w.once('ready', () => resolve()));
    return {
      ready,
      notWatched: () => refused.size,
      close: async () => {
        await w.close();
        budget.release(mine);
      },
    };
  };
}

export const chokidarWatch: WatchFactory = createChokidarWatch(processWatchBudget);
