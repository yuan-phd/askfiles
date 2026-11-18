import fsp from 'node:fs/promises';
import path from 'node:path';
import { isSkippedFolderName, VENV_MARKER } from './file-types.js';

/**
 * Most subfolders one library may watch, and most folders the whole process watches at once. A
 * linked folder itself does not count, only the folders below it, so a folder with exactly this
 * many subfolders is accepted and the words "more than 1,000 subfolders" match the check.
 *
 * On macOS every watched folder is one path of a single FSEvents stream that libuv keeps for the
 * process: at 4,097 every watch fails and the window freezes for 80 to 130 s (scripts/
 * measure-watch-limit.ts). Well below that, closing the watches is what freezes the window: it is
 * synchronous in the main process and grows with the square of the folder count. Measured
 * 2026-11-18 in the packaged app on the owner's Mac with invented trees (docs/tickets/
 * large-folder-blocks-window.md): switching away from or deleting a library froze the window for
 * 2.9 s at 1,000 subfolders, 6.2 s at 1,500 and 14 s at 2,000; startup and switching to it stayed
 * under 1 s. 1,000 is the largest measured size under 5 s (owner decision 2026-11-18). Files are
 * watched through kqueue, not FSEvents, and do not count.
 */
export const WATCH_FOLDER_LIMIT = 1000;

/**
 * The folders the process watches, shared by every watch it opens (chokidarWatch asks before each
 * folder). Only the current library is watched, but a library over the limit at start, a folder
 * that grows while watched, or a watch opened while another closes must still never reach 4,096,
 * whatever the add-time check let through. A folder refused stays unwatched until the watch is
 * opened again; its changes are found by Check for updates and at the next start.
 */
export class WatchBudget {
  /** Every folder watched; true when it counts toward the limit (a linked folder itself does not). */
  private readonly watched = new Map<string, boolean>();
  private counted = 0;

  constructor(readonly limit: number = WATCH_FOLDER_LIMIT) {}

  /**
   * True when dir may be watched (it is watched already, or there is room), and records it for
   * owner. counts false: the root of a linked folder's watch, which is never refused and takes no
   * place, as the add-time count leaves it out too (countFolders).
   */
  admit(dir: string, owner: Set<string>, o: { counts?: boolean } = {}): boolean {
    const counts = o.counts ?? true;
    if (this.watched.has(dir)) {
      owner.add(dir);
      return true;
    }
    if (counts && this.counted >= this.limit) return false;
    this.watched.set(dir, counts);
    if (counts) this.counted++;
    owner.add(dir);
    return true;
  }

  /** The folders of a watch that closed are free again. */
  release(owner: Set<string>): void {
    for (const d of owner) {
      const counts = this.watched.get(d);
      if (counts === undefined) continue;
      this.watched.delete(d);
      if (counts) this.counted--;
    }
    owner.clear();
  }

  /** Folders that count toward the limit. */
  get size(): number {
    return this.counted;
  }
}

/** The budget of this process; tests make their own. */
export const processWatchBudget = new WatchBudget();

/** One root to count: a linked folder with everything below it, or one folder alone (added files). */
export interface CountRoot {
  path: string;
  /** False: only the folder itself, as the folder of individually added files is watched. */
  recursive: boolean;
}

/**
 * Folders that watching roots would take, after the skips (src/main/watcher/file-types.ts): below a
 * recursive root every folder that is not skipped by name or a Python virtual environment, but not
 * the recursive root itself (a linked folder counts its subfolders only, like WatchBudget), and each
 * folder of added files. A folder counted twice (an added file's folder inside a linked folder)
 * counts once.
 * Reads folders one at a time with the asynchronous API, so the window keeps getting events while a
 * large tree is counted, and stops as soon as the count passes stopAbove: an add only has to know
 * that a folder is too large, not by how much. Folders that cannot be read count as themselves.
 */
export async function countFolders(
  roots: CountRoot[],
  o: { stopAbove?: number; stopped?: () => boolean } = {},
): Promise<{ count: number; over: boolean }> {
  const stopAbove = o.stopAbove ?? Infinity;
  // Queued once; counted once read, so a virtual environment waiting in the queue never counts.
  const queued = new Set<string>();
  let count = 0;
  const queue: string[] = [];
  for (const r of roots) {
    if (!r.recursive || queued.has(r.path)) continue;
    queued.add(r.path);
    queue.push(r.path);
  }
  const isRoot = new Set(roots.filter((r) => r.recursive).map((r) => r.path));
  while (queue.length) {
    if (o.stopped?.()) break;
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable: the watch would still try it, so it counts.
    }
    const sub: string[] = [];
    let venv = false;
    for (const e of entries) {
      if (e.isFile() && e.name === VENV_MARKER) venv = true;
      // Symbolic links are not followed, as the watch does not follow them.
      else if (e.isDirectory() && !isSkippedFolderName(e.name)) sub.push(path.join(dir, e.name));
    }
    // A virtual environment below a root is skipped whole.
    if (venv && !isRoot.has(dir)) continue;
    if (!isRoot.has(dir)) {
      count++;
      if (count > stopAbove) return { count, over: true };
    }
    for (const d of sub) {
      if (queued.has(d)) continue;
      queued.add(d);
      queue.push(d);
    }
  }
  // Folders of added files, after the walk: one already watched as part of a linked folder is not a second watch.
  for (const r of roots) {
    if (r.recursive || queued.has(r.path)) continue;
    queued.add(r.path);
    count++;
  }
  return { count, over: count > stopAbove };
}
