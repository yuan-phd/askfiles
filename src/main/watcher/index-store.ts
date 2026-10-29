import fs from 'node:fs';
import path from 'node:path';
import type { IndexData } from './types.js';

export function emptyIndex(): IndexData {
  return { version: 1, files: {} };
}

/**
 * Reads <dataDir>/index.json. A missing file is an empty index. A damaged file is set aside as
 * index.json.broken-<time> and treated as empty, so the next reconcile re-indexes the folder
 * instead of the shell failing to start.
 */
export function loadIndex(file: string, log: (msg: string) => void = () => {}): IndexData {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
    throw e;
  }
  try {
    const data = JSON.parse(raw) as IndexData;
    if (data && data.version === 1 && typeof data.files === 'object' && data.files !== null) return data;
    throw new Error('unexpected shape');
  } catch (e) {
    const aside = `${file}.broken-${Date.now()}`;
    fs.renameSync(file, aside);
    log(`index ${file} unreadable (${(e as Error).message}), moved to ${aside}`);
    return emptyIndex();
  }
}

/** Write to a temp file and rename, so a crash mid-write never leaves half an index. */
export function saveIndex(file: string, data: IndexData): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
