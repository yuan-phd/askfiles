import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sectionSplitter } from '../splitter.js';
import type { LibraryApi, Splitter, WatchEventType, WatchFactory } from '../types.js';

/** The real splitter (src/main/sections) with a small chunk maximum, counting its calls. */
export function countingSplitter(maxChars = 400): Splitter & { calls: string[] } {
  const inner = sectionSplitter({ maxChars, embeddingModel: 'all-minilm:latest' });
  const calls: string[] = [];
  return {
    calls,
    splitKey: inner.splitKey,
    async split(file) {
      calls.push(file);
      return inner.split(file);
    },
  };
}

export interface FakeApi extends LibraryApi {
  embedded: Map<string, string>;
  log: string[];
  /** Number of upcoming calls to fail. */
  failNext: number;
  /** When set, updateEmbeddings accepts the call but embeds nothing, like a silent upstream failure. */
  dropAdds: boolean;
}

/** In-memory workspace. removeDocuments also deletes the JSON, as remove-documents does upstream. */
export function fakeApi(storageDir: string): FakeApi {
  const api: FakeApi = {
    embedded: new Map(),
    log: [],
    failNext: 0,
    dropAdds: false,
    async updateEmbeddings(_slug, { adds, deletes }) {
      api.log.push(`embed +${adds.length} -${deletes.length}`);
      if (api.failNext > 0) {
        api.failNext--;
        throw new Error('POST /v1/workspace/library/update-embeddings failed (500): boom');
      }
      if (!api.dropAdds) for (const a of adds) api.embedded.set(a, crypto.randomUUID());
      for (const d of deletes) api.embedded.delete(d);
    },
    async removeDocuments(_slug, locations) {
      api.log.push(`remove ${locations.length}`);
      if (api.failNext > 0) {
        api.failNext--;
        throw new Error('DELETE /v1/system/remove-documents failed (500): boom');
      }
      for (const l of locations) {
        api.embedded.delete(l);
        fs.rmSync(path.join(storageDir, 'documents', l), { force: true });
      }
    },
    async workspaceDocuments() {
      return new Map(api.embedded);
    },
  };
  return api;
}

/** A watch the test drives by hand. */
export function manualWatch(): WatchFactory & { emit: (type: WatchEventType, p: string) => void; closed: boolean } {
  let handler: ((type: WatchEventType, p: string) => void) | null = null;
  const f = ((_root, onEvent) => {
    handler = onEvent;
    return {
      ready: Promise.resolve(),
      close: async () => {
        f.closed = true;
      },
    };
  }) as WatchFactory & { emit: (type: WatchEventType, p: string) => void; closed: boolean };
  f.closed = false;
  f.emit = (type, p) => handler?.(type, p);
  return f;
}
