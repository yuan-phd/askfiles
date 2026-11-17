import fsp from 'node:fs/promises';
import path from 'node:path';
import { isSkippedFolderName, VENV_MARKER } from './file-types.js';

/**
 * Most folders one library may watch, and most folders the whole process watches at once.
 *
 * On macOS every watched folder is one path of a single FSEvents stream that libuv keeps for the
 * process. Measured 2026-11-16 on the owner's Mac (scripts/measure-watch-limit.ts, Node 22.23.4
 * and Electron 44.10.0, invented trees): 4,096 watched folders work; at 4,097 the stream cannot
 * start, every watch of the process fails with EMFILE, including those that worked, and the main
 * process stalls for 80 to 130 s while the failures are delivered, which freezes the window. The
 * longest stall below the limit grows with the count (Electron: 88 ms at 3,000, 155 ms at 4,000).
 * 3,000 keeps a quarter of the stream free and the stall under 100 ms. Files are watched through
 * kqueue, not FSEvents, and do not count.
 */
export const WATCH_FOLDER_LIMIT = 3000;

/**
 * The folders the process watches, shared by every watch it opens (chokidarWatch asks before each
 * folder). Only the current library is watched, but a library over the limit at start, a folder
 * that grows while watched, or a watch opened while another closes must still never reach 4,096,
 * whatever the add-time check let through. A folder refused stays unwatched until the watch is
 * opened again; its changes are found by Check for updates and at the next start.
 */
export class WatchBudget {
  private readonly watched = new Set<string>();

  constructor(readonly limit: number = WATCH_FOLDER_LIMIT) {}

  /** True when dir may be watched (it is watched already, or there is room), and counts it for owner. */
  admit(dir: string, owner: Set<string>): boolean {
    if (this.watched.has(dir)) {
      owner.add(dir);
      return true;
    }
    if (this.watched.size >= this.limit) return false;
    this.watched.add(dir);
    owner.add(dir);
    return true;
  }

  /** The folders of a watch that closed are free again. */
  release(owner: Set<string>): void {
    for (const d of owner) this.watched.delete(d);
    owner.clear();
  }

  get size(): number {
    return this.watched.size;
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
 * Folders that watching roots would take, after the skips (src/main/watcher/file-types.ts): each
 * root, and below a recursive one every folder that is not skipped by name or a Python virtual
 * environment. A folder counted twice (an added file's folder inside a linked folder) counts once.
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
    count++;
    if (count > stopAbove) return { count, over: true };
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
