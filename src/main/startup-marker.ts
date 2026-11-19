import fs from 'node:fs';
import path from 'node:path';

/**
 * <dataDir>/startup.json: written just before a library's watcher starts, removed once the library
 * runs or stops cleanly (docs/tickets/startup-index-now-or-later.md). Found at the next start, it
 * means that start never finished (a freeze or a crash while walking the folders), so the user is
 * asked whether to index now or later. A data folder from a version before the marker has none and
 * starts as before.
 */
export interface StartMarker {
  libraryId: string;
  startedAt: string;
}

export const START_MARKER_FILE = 'startup.json';

const markerPath = (dataDir: string) => path.join(dataDir, START_MARKER_FILE);

/** The marker a previous start left, or null; an unreadable marker counts as none. */
export function readStartMarker(dataDir: string): StartMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(dataDir), 'utf8')) as Partial<StartMarker>;
    if (typeof m?.libraryId !== 'string' || !m.libraryId) return null;
    return { libraryId: m.libraryId, startedAt: typeof m.startedAt === 'string' ? m.startedAt : '' };
  } catch {
    return null;
  }
}

/** Through a temporary file, so a crash while writing never leaves half a marker. */
export function writeStartMarker(dataDir: string, libraryId: string, now: Date = new Date()): void {
  const file = markerPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ libraryId, startedAt: now.toISOString() }) + '\n');
  fs.renameSync(tmp, file);
}

export function clearStartMarker(dataDir: string): void {
  fs.rmSync(markerPath(dataDir), { force: true });
}
