// Puts a corpus into the hidden workspace the way the shell will: split by section in this
// process, one document JSON per chunk in STORAGE_DIR/documents, then update-embeddings
// (docs/upstream-analysis.md Q13, route b2).
import fs from 'node:fs';
import path from 'node:path';
import { REFUSAL_TEXT } from '../../src/renderer/api/client.js';
import {
  chunkSections,
  isSupported,
  parseFile,
  parsePlainText,
  sectionDocuments,
  sha256,
  splitKeyOf,
  SPLITTER_VERSION,
  type Chunk,
  type ParsedDocument,
} from '../../src/main/sections/index.js';
import type { FileRecord } from '../../src/main/watcher/index.js';
import type { EvalConfig } from './config.js';

/** Folder under STORAGE_DIR/documents for the harness's documents; the app's library uses another. */
export const DOC_FOLDER = 'askfiles-eval';
const EMBED_BATCH = 20;

// Only the client methods this module calls; createClient in src/renderer/api/client.js.
export interface LibraryClient {
  listWorkspaces(): Promise<{ name: string; slug: string }[]>;
  createWorkspace(name: string, settings: Record<string, unknown>): Promise<{ slug: string }>;
  updateWorkspace(slug: string, settings: Record<string, unknown>): Promise<unknown>;
  getWorkspace(slug: string): Promise<{ documents?: { docpath: string }[] } | null>;
  embedDocuments(slug: string, body: { adds?: string[]; deletes?: string[] }): Promise<unknown>;
  uploadDocument(file: Blob, opts: { filename: string }): Promise<{ location: string; pageContent: string }[]>;
}

export interface FileReport {
  file: string;
  outline: string;
  pages: number;
  sections: number;
  chunks: number;
  longestChunk: number;
  /** Sections cut into more than one chunk. */
  splitSections: number;
  ocr: boolean;
  skipped?: string;
}

/** Where a chunk came from, for mapping vector-search results back to sections. */
export interface ChunkInfo {
  file: string;
  sectionTitle: string;
  sectionIndex: number;
  pageStart: number;
  pageEnd: number;
}

export interface Library {
  slug: string;
  workspaceName: string;
  files: FileReport[];
  /** Chunk text (pageContent) to its section. */
  chunkIndex: Map<string, ChunkInfo>;
  /** The files as the folder watcher records them (index.json), for the browse index and the source resolver. */
  records: FileRecord[];
  stats: {
    files: number;
    skipped: number;
    chunks: number;
    added: number;
    reused: number;
    removed: number;
    splitMs: number;
    embedMs: number;
  };
}

/** Every file under dir, relative paths sorted, hidden files and folders left out. */
export function listCorpus(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** Workspace name per embedding model: vectors of different embedders never share a table. */
export function workspaceNameFor(config: Pick<EvalConfig, 'workspace' | 'embeddingModel'>): string {
  return `${config.workspace}-${sha256(config.embeddingModel).slice(0, 8)}`;
}

export function workspaceSettings(config: EvalConfig): Record<string, unknown> {
  return {
    chatMode: config.chatMode,
    similarityThreshold: config.similarityThreshold,
    topN: config.topN,
    openAiTemp: config.temperature,
    openAiPrompt: config.systemPrompt,
    queryRefusalResponse: REFUSAL_TEXT,
    vectorSearchMode: config.rerank ? 'rerank' : 'default',
    chatProvider: 'ollama',
    chatModel: config.chatModel,
  };
}

/** Additions and removals that turn the workspace's documents into the wanted set. */
export function diffDocuments(present: string[], wanted: string[]): { adds: string[]; deletes: string[] } {
  const have = new Set(present);
  const want = new Set(wanted);
  return { adds: wanted.filter((d) => !have.has(d)), deletes: present.filter((d) => !want.has(d)) };
}

async function ocrText(
  client: LibraryClient,
  removeDocuments: (names: string[]) => Promise<void>,
  file: string,
  cacheDir: string,
  hash: string,
): Promise<string> {
  const cached = path.join(cacheDir, `${hash}.txt`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  // The collector OCRs a PDF without a text layer on upload. The upload is not added to any
  // workspace and is deleted again; only its text is kept, cached by file hash.
  const docs = await client.uploadDocument(new Blob([fs.readFileSync(file)]), { filename: path.basename(file) });
  const text = docs.map((d) => d.pageContent).join('\n\n');
  await removeDocuments(docs.map((d) => d.location));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cached, text);
  return text;
}

export async function prepareLibrary(opts: {
  client: LibraryClient;
  removeDocuments: (names: string[]) => Promise<void>;
  config: EvalConfig;
  corpusDir: string;
  storageDir: string;
  log: (msg: string) => void;
}): Promise<Library> {
  const { client, config, corpusDir, storageDir, log } = opts;
  const splitKey = splitKeyOf({
    splitterVersion: SPLITTER_VERSION,
    strategy: config.chunkStrategy,
    maxChars: config.chunkMax,
    embeddingModel: config.embeddingModel,
  });
  const docDir = path.join(storageDir, 'documents', DOC_FOLDER);
  const cacheDir = path.join(storageDir, 'askfiles-eval-cache', 'ocr');
  fs.mkdirSync(docDir, { recursive: true });
  const published = new Date().toLocaleString('en-US');

  const t0 = performance.now();
  const files: FileReport[] = [];
  const wanted: string[] = [];
  const chunkIndex = new Map<string, ChunkInfo>();
  const records: FileRecord[] = [];
  for (const rel of listCorpus(corpusDir)) {
    const abs = path.join(corpusDir, rel);
    if (!isSupported(rel)) {
      files.push({
        file: rel,
        outline: '',
        pages: 0,
        sections: 0,
        chunks: 0,
        longestChunk: 0,
        splitSections: 0,
        ocr: false,
        skipped: 'unsupported type',
      });
      log(`skip ${rel}: unsupported type`);
      continue;
    }
    const hash = sha256(fs.readFileSync(abs));
    let parsed: ParsedDocument;
    try {
      parsed = await parseFile(abs);
      if (parsed.needsOcr) {
        log(`${rel}: no text layer, OCR through the collector`);
        const text = await ocrText(client, opts.removeDocuments, abs, cacheDir, hash);
        parsed = { ...parsePlainText(text, rel), pages: parsed.pages, needsOcr: true };
      }
    } catch (e) {
      files.push({
        file: rel,
        outline: '',
        pages: 0,
        sections: 0,
        chunks: 0,
        longestChunk: 0,
        splitSections: 0,
        ocr: false,
        skipped: (e as Error).message,
      });
      log(`skip ${rel}: ${(e as Error).message}`);
      continue;
    }
    const chunks: Chunk[] = chunkSections(parsed.sections, { maxChars: config.chunkMax });
    const docs = sectionDocuments(chunks, { path: abs, relPath: rel, hash }, { splitKey, published });
    const stat = fs.statSync(abs);
    records.push({
      path: abs,
      url: docs[0]?.doc.url ?? '',
      hash,
      splitKey,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      indexedAt: new Date().toISOString(),
      sections: docs.map(({ name, doc }) => ({
        location: `${DOC_FOLDER}/${name}`,
        docId: null,
        sectionTitle: doc.sectionTitle,
        sectionIndex: doc.sectionIndex,
        subIndex: doc.subIndex,
        pageStart: doc.pageStart > 0 ? doc.pageStart : null,
        pageEnd: doc.pageEnd > 0 ? doc.pageEnd : null,
      })),
    });
    for (const { name, doc } of docs) {
      const target = path.join(docDir, name);
      // Same name means same file bytes and split settings, so the content is the same too.
      if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify(doc));
      wanted.push(`${DOC_FOLDER}/${name}`);
      chunkIndex.set(doc.pageContent.trim(), {
        file: doc.title,
        sectionTitle: doc.sectionTitle,
        sectionIndex: doc.sectionIndex,
        pageStart: doc.pageStart,
        pageEnd: doc.pageEnd,
      });
    }
    files.push({
      file: rel,
      outline: parsed.outline,
      pages: parsed.pages,
      sections: new Set(chunks.map((c) => c.sectionIndex)).size,
      chunks: chunks.length,
      longestChunk: Math.max(0, ...chunks.map((c) => c.text.length)),
      splitSections: new Set(chunks.filter((c) => c.subCount > 1).map((c) => c.sectionIndex)).size,
      ocr: parsed.needsOcr,
    });
    log(`${rel}: ${parsed.outline}, ${chunks.length} chunk(s)${parsed.needsOcr ? ', OCR' : ''}`);
  }
  const splitMs = Math.round(performance.now() - t0);

  const workspaceName = workspaceNameFor(config);
  const settings = workspaceSettings(config);
  const existing = (await client.listWorkspaces()).find((w) => w.name === workspaceName);
  const slug = existing ? existing.slug : (await client.createWorkspace(workspaceName, settings)).slug;
  if (existing) await client.updateWorkspace(slug, settings);
  log(`workspace ${slug} (${existing ? 'reused' : 'created'})`);

  const present = ((await client.getWorkspace(slug))?.documents ?? []).map((d) => d.docpath);
  const { adds, deletes } = diffDocuments(present, wanted);
  // Removed from the workspace only; the JSON stays so switching back to these settings reuses the
  // vector cache.
  if (deletes.length) await client.embedDocuments(slug, { deletes });
  const t1 = performance.now();
  for (let i = 0; i < adds.length; i += EMBED_BATCH) {
    const batch = adds.slice(i, i + EMBED_BATCH);
    await client.embedDocuments(slug, { adds: batch });
    log(`embedded ${Math.min(i + EMBED_BATCH, adds.length)} of ${adds.length}`);
  }
  const embedMs = Math.round(performance.now() - t1);

  // Upstream does not report per-document embedding failures, so compare what the workspace holds.
  const after = new Set(((await client.getWorkspace(slug))?.documents ?? []).map((d) => d.docpath));
  const missing = wanted.filter((d) => !after.has(d));
  if (missing.length) {
    throw new Error(
      `${missing.length} document(s) were not embedded, first: ${missing.slice(0, 3).join(', ')}; see the server log`,
    );
  }
  const skipped = files.filter((f) => f.skipped).length;
  return {
    slug,
    workspaceName,
    files,
    chunkIndex,
    records,
    stats: {
      files: files.length - skipped,
      skipped,
      chunks: wanted.length,
      added: adds.length,
      reused: wanted.length - adds.length,
      removed: deletes.length,
      splitMs,
      embedMs,
    },
  };
}
