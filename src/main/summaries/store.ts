/**
 * Summaries on disk, next to the library's section records: <libraryDir>/summaries/<document id>.json.
 * A dropped summary is kept with its reason, so it is not asked for again until its source or the
 * version key (model tag and prompt version) changes.
 */
import fs from 'node:fs';
import path from 'node:path';

export type SummaryStatus = 'ok' | 'too-long' | 'unsupported' | 'empty' | 'failed';

export interface StoredSummary {
  /** The sentence; null unless status is ok. */
  text: string | null;
  status: SummaryStatus;
  /** versionKey() when it was made; another key means stale. */
  key: string;
  /** textHash of the source the model was given; another hash means the source changed. */
  sourceHash: string;
  at: string;
}

export interface DocumentSummaries {
  version: 1;
  documentId: string;
  /** Cited to this section of the document (the first with text), the start of its source. */
  sectionIndex: number | null;
  document: StoredSummary | null;
  /** By section index. */
  sections: Record<string, StoredSummary>;
  /** The user asked for this document's section summaries on its Document page. */
  sectionsWanted: boolean;
}

export function versionKey(model: string, promptVersion: number): string {
  return `${model}|p${promptVersion}`;
}

export function emptySummaries(documentId: string): DocumentSummaries {
  return { version: 1, documentId, sectionIndex: null, document: null, sections: {}, sectionsWanted: false };
}

const ID = /^[0-9a-f]{16}$/;

export class SummaryStore {
  private readonly cache = new Map<string, DocumentSummaries>();

  constructor(private readonly dir: string) {}

  get(id: string): DocumentSummaries {
    const hit = this.cache.get(id);
    if (hit) return hit;
    let rec = emptySummaries(id);
    if (ID.test(id)) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as DocumentSummaries;
        if (raw?.version === 1 && raw.documentId === id) rec = { ...emptySummaries(id), ...raw };
      } catch {
        // None yet, or unreadable: made again.
      }
    }
    this.cache.set(id, rec);
    return rec;
  }

  put(rec: DocumentSummaries): void {
    if (!ID.test(rec.documentId)) throw new Error(`not a document id: ${rec.documentId}`);
    this.cache.set(rec.documentId, rec);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${rec.documentId}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
  }

  remove(id: string): void {
    this.cache.delete(id);
    if (ID.test(id)) fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }

  /** Ids with a file on disk. */
  ids(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5))
        .filter((id) => ID.test(id));
    } catch {
      return [];
    }
  }
}
