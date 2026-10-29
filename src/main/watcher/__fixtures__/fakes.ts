import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LibraryApi, Section, Splitter, WatchEventType, WatchFactory } from '../types.js';

/** Stands in for Session G's splitter: one section per file, titled with the file name. */
export function oneSectionSplitter(): Splitter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async split(file) {
      calls.push(file);
      return [
        {
          sectionTitle: path.basename(file),
          sectionIndex: 1,
          pageStart: null,
          pageEnd: null,
          text: fs.readFileSync(file, 'utf8'),
        },
      ];
    },
  };
}

/** Splits on lines starting with "# ", for tests that need several sections per file. */
export function headingSplitter(): Splitter {
  return {
    async split(file) {
      const out: Section[] = [];
      for (const block of fs.readFileSync(file, 'utf8').split(/^(?=# )/m)) {
        const title = /^# (.*)$/m.exec(block)?.[1] ?? 'Untitled';
        out.push({
          sectionTitle: title,
          sectionIndex: out.length + 1,
          pageStart: out.length + 1,
          pageEnd: out.length + 1,
          text: block.trim(),
        });
      }
      return out;
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
