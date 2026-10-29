import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileRecord } from './watcher/index.js';

/** What the search page knows about a source when the user asks to open it. */
export interface SourceRef {
  title?: string | null;
  url?: string | null;
  /** Document path inside the server storage (docpath, location), when a source carries one. */
  location?: string | null;
}

function baseOfUrl(url: string): string | null {
  try {
    return path.basename(url.startsWith('file:') ? fileURLToPath(url) : new URL(url).pathname);
  } catch {
    return null;
  }
}

/**
 * Maps a source to the user's original file through index.json. Only files in the index are ever
 * returned, so the page cannot make the shell reveal an arbitrary path. In order: the file URL the
 * section documents carry; the stored document path of a section; and for anything else, such as
 * an upload path inside the server storage (collector hotdir, custom-documents), the file name,
 * when exactly one indexed file has it.
 */
export function findOriginal(ref: SourceRef, files: FileRecord[]): string | null {
  if (ref.url) {
    const byUrl = files.find((f) => f.url === ref.url);
    if (byUrl) return byUrl.path;
  }
  if (ref.location) {
    const loc = ref.location.replace(/\\/g, '/');
    const byLocation = files.find((f) => f.sections.some((s) => s.location === loc));
    if (byLocation) return byLocation.path;
  }
  for (const name of [ref.url ? baseOfUrl(ref.url) : null, ref.title ?? null]) {
    if (!name) continue;
    const byName = files.filter((f) => path.basename(f.path) === name);
    if (byName.length === 1) return byName[0]!.path;
  }
  return null;
}
