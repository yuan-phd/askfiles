/**
 * The summary layer of the current library (docs/summaries.md). Document summaries are made after
 * a document is indexed, section summaries when the user asks for one document's or turns on the
 * library switch; one at a time through the queue, through the same Ollama model and context as
 * Ask so the model is never loaded twice. A changed file redoes only its changed sections and its
 * document summary; a removed file loses its summaries; a new model or prompt version marks every
 * summary stale.
 */
import type { ChatFn } from '../answer/ollama-chat.js';
import type { BrowseChange, BrowseIndex } from '../browse/index.js';
import type { BrowseDocument } from '../browse/types.js';
import type { GraphData } from '../graph/build.js';
import { exportFiles, writeExport } from './export.js';
import { SummaryQueue, type QueueStatus, type SummaryJob } from './queue.js';
import { emptySummaries, SummaryStore, versionKey, type DocumentSummaries, type StoredSummary } from './store.js';
import {
  BATCH_MAX_SECTIONS,
  BATCH_MAX_TOKENS,
  checkSummary,
  documentPrompt,
  documentSource,
  estimateTokens,
  parseBatchReply,
  sectionBatchPrompt,
  sectionPrompt,
  sectionSource,
  SUMMARY_PROMPT_VERSION,
  textHash,
  type CheckOutcome,
} from './text.js';

export interface SummaryModel {
  model: string;
  contextLength: number;
  temperature: number;
}

export interface SummaryServiceDeps {
  browse: BrowseIndex;
  /** <libraryDir>/summaries */
  dir: string;
  /** <libraryDir>/export */
  exportDir: string;
  chat: ChatFn;
  /** The chat model, or null on a tier that makes no summaries (8 GB, Ask off). */
  model(): SummaryModel | null;
  /** The library switch: section summaries for every document. */
  librarySections(): boolean;
  graph(): GraphData;
  onStatus?(s: SummaryStatusView): void;
  /** Documents whose summaries changed, for the pages to refresh. */
  onChange?(ids: string[]): void;
  idleMs?: number;
  exportDebounceMs?: number;
  log?: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export type SummaryStatusView = QueueStatus & { enabled: boolean; userPaused: boolean };

/** What a page shows for one document. */
export interface DocumentSummaryView {
  documentId: string;
  /** off: this tier makes none; pending: queued or not made yet; none: dropped (unsupported or too long). */
  state: 'ok' | 'pending' | 'none' | 'off';
  text: string | null;
  /** The section the summary cites. */
  sectionIndex: number | null;
  sections: Record<string, string>;
  sectionsWanted: boolean;
  /** Sections still to summarize when the user's or the library's request covers them. */
  sectionsPending: number;
  /** Sections without a current summary, for the button's estimate. */
  sectionsMissing: number;
  /** Estimated minutes for sectionsMissing at the measured pace. */
  estimateMinutes: number;
}

/**
 * Until a few sections were timed: per section, batched up to 5 to a call. Measured on 2026-11-04
 * on the owner's M1 Max over 20 sections of the Procurement Regulations: 3.6 s with the Ask model
 * qwen3 14B q4_K_M, which summaries use (docs/summaries.md, Batches).
 */
export const DEFAULT_MS_PER_SECTION = 3600;

export class SummaryService {
  readonly store: SummaryStore;
  private readonly queue: SummaryQueue;
  private readonly off: () => void;
  private readonly log: (msg: string) => void;
  private exportTimer: unknown = null;
  /** Milliseconds per section of the last runs (a batch adds its time divided by its size). */
  private readonly durations: number[] = [];
  private userPaused = false;
  /** While the library indexes the export waits: writing it reads the graph, which then rebuilds. */
  private indexing = false;
  private exportWanted = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: SummaryServiceDeps) {
    this.log = (m) => (d.log ?? (() => {}))(`[summaries] ${m}`);
    this.store = new SummaryStore(d.dir);
    this.setTimer =
      d.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.queue = new SummaryQueue({
      run: (jobs, signal) => this.run(jobs, signal),
      batch: (first, queued) => this.batchFor(first, queued),
      onStatus: () => this.d.onStatus?.(this.status()),
      idleMs: d.idleMs,
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
      log: this.log,
    });
    this.queue.setGate('off', !d.model());
    this.off = d.browse.onChange((c) => this.onBrowse(c));
  }

  stop(): void {
    this.off();
    this.queue.clear();
    if (this.exportTimer !== null) this.clearTimer(this.exportTimer);
  }

  // --- gates ----------------------------------------------------------------------------------

  setIndexing(on: boolean): void {
    this.queue.setGate('indexing', on);
    if (on === this.indexing) return;
    this.indexing = on;
    if (on && this.exportTimer !== null) {
      this.clearTimer(this.exportTimer);
      this.exportTimer = null;
      this.exportWanted = true;
    }
    if (!on && this.exportWanted) this.scheduleExport();
  }

  setAnswering(on: boolean): void {
    this.queue.setGate('answering', on);
  }

  pause(): SummaryStatusView {
    this.userPaused = true;
    this.queue.pause();
    return this.status();
  }

  resume(): SummaryStatusView {
    this.userPaused = false;
    this.queue.resume();
    return this.status();
  }

  status(): SummaryStatusView {
    return { ...this.queue.status(), enabled: !!this.d.model(), userPaused: this.userPaused };
  }

  // --- planning -------------------------------------------------------------------------------

  /** Brings the queue up to date with every document; drops summaries of documents that are gone. */
  reconcile(): void {
    const docs = this.d.browse.allDocuments();
    const ids = new Set(docs.map((d) => d.id));
    for (const id of this.store.ids()) if (!ids.has(id)) this.store.remove(id);
    for (const doc of docs) this.plan(doc);
    this.scheduleExport();
  }

  /** The model changed (Settings) or the tier: stale keys are found by the next plan. */
  modelChanged(): void {
    this.queue.setGate('off', !this.d.model());
    this.queue.clear();
    this.reconcile();
  }

  /** The library switch changed: plan again; switching off drops the library's queued section jobs. */
  librarySectionsChanged(): void {
    if (!this.d.librarySections()) {
      this.queue.clear();
    }
    this.reconcile();
  }

  /** The Document page button: this document's section summaries, now and after later changes. */
  requestSections(docId: string): DocumentSummaryView | null {
    const doc = this.d.browse.getDocument({ id: docId });
    if (!doc) return null;
    const rec = this.store.get(docId);
    if (!rec.sectionsWanted) this.store.put({ ...rec, sectionsWanted: true });
    this.plan(doc);
    return this.view(docId);
  }

  private key(): string | null {
    const m = this.d.model();
    return m ? versionKey(m.model, SUMMARY_PROMPT_VERSION) : null;
  }

  private fresh(s: StoredSummary | null | undefined, key: string, hash: string): boolean {
    return !!s && s.key === key && s.sourceHash === hash;
  }

  /**
   * The document summary's source fingerprint: its text and the file's hash, so any change to the
   * file redoes it (the brief: a changed file redoes the changed sections and the document summary).
   */
  private documentHash(doc: BrowseDocument): string {
    return textHash(`${doc.hash}\n${documentSource(doc).text}`);
  }

  private plan(doc: BrowseDocument): void {
    const key = this.key();
    let rec = this.store.get(doc.id);
    // Section summaries of sections the file no longer has are dropped at once.
    const indexes = new Set(doc.sections.map((s) => String(s.index)));
    const stale = Object.keys(rec.sections).filter((k) => !indexes.has(k));
    if (stale.length) {
      const sections = { ...rec.sections };
      for (const k of stale) delete sections[k];
      rec = { ...rec, sections };
      this.store.put(rec);
    }
    if (!key) return;
    if (!this.fresh(rec.document, key, this.documentHash(doc))) this.queue.add({ docId: doc.id, level: 'document' });
    const library = this.d.librarySections();
    if (!library && !rec.sectionsWanted) return;
    for (const s of doc.sections) {
      if (!s.text.trim()) continue;
      if (this.fresh(rec.sections[String(s.index)], key, textHash(sectionSource(doc, s)))) continue;
      this.queue.add({
        docId: doc.id,
        level: 'section',
        sectionIndex: s.index,
        origin: rec.sectionsWanted ? 'document' : 'library',
      });
    }
  }

  private onBrowse(c: BrowseChange): void {
    if (c.type === 'remove') {
      this.queue.removeDocument(c.id);
      this.store.remove(c.id);
      this.d.onChange?.([c.id]);
      this.scheduleExport();
    } else if (c.type === 'update') {
      if (!c.sections) return;
      const doc = this.d.browse.getDocument({ id: c.id });
      if (doc) this.plan(doc);
      this.scheduleExport();
    } else {
      this.reconcile();
    }
  }

  // --- running --------------------------------------------------------------------------------

  private async ask(messages: Parameters<ChatFn>[0]['messages'], signal: AbortSignal): Promise<string> {
    const m = this.d.model();
    if (!m) throw new Error('summaries are off on this tier');
    let text = '';
    await this.d.chat(
      { model: m.model, messages, temperature: m.temperature, contextLength: m.contextLength, signal },
      (t) => {
        text += t;
      },
    );
    return text;
  }

  private async generate(
    prompt: (shorter: boolean) => Parameters<ChatFn>[0]['messages'],
    source: string,
    level: 'document' | 'section',
    signal: AbortSignal,
  ): Promise<CheckOutcome> {
    let out = checkSummary(await this.ask(prompt(false), signal), source, level);
    // One more try, asked to be shorter, when the first reply ran over the cap.
    if (!out.ok && out.reason === 'too-long' && !signal.aborted)
      out = checkSummary(await this.ask(prompt(true), signal), source, level);
    return out;
  }

  /**
   * The section jobs that share a model call with first: later queued sections of the same document
   * and request, in order, up to BATCH_MAX_SECTIONS and BATCH_MAX_TOKENS of section text.
   */
  private batchFor(first: SummaryJob, queued: SummaryJob[]): SummaryJob[] {
    if (first.level !== 'section') return [];
    const doc = this.d.browse.getDocument({ id: first.docId });
    if (!doc) return [];
    const size = (j: SummaryJob) => {
      const sec = j.level === 'section' ? doc.sections.find((s) => s.index === j.sectionIndex) : null;
      return sec ? estimateTokens(sectionSource(doc, sec)) : Infinity;
    };
    let tokens = size(first);
    const out: SummaryJob[] = [];
    for (const j of queued) {
      if (out.length + 1 >= BATCH_MAX_SECTIONS) break;
      if (j.level !== 'section' || j.docId !== first.docId || j.origin !== first.origin) continue;
      const t = size(j);
      if (tokens + t > BATCH_MAX_TOKENS) break;
      tokens += t;
      out.push(j);
    }
    return out;
  }

  private async run(jobs: SummaryJob[], signal: AbortSignal): Promise<void> {
    const job = jobs[0]!;
    const key = this.key();
    const doc = this.d.browse.getDocument({ id: job.docId });
    if (!key || !doc) return;
    const t0 = Date.now();
    let entry: StoredSummary;
    let rec: DocumentSummaries;
    if (job.level === 'section' && jobs.length > 1) {
      await this.runBatch(doc, jobs, key, signal);
      if (signal.aborted) return;
      const per = (Date.now() - t0) / jobs.length;
      for (let i = 0; i < jobs.length; i++) this.durations.push(per);
      while (this.durations.length > 20) this.durations.shift();
      this.d.onChange?.([doc.id]);
      this.scheduleExport();
      return;
    }
    if (job.level === 'document') {
      const src = documentSource(doc);
      const out = await this.generate((shorter) => documentPrompt(doc, { shorter }), src.text, 'document', signal);
      if (signal.aborted) return;
      entry = summaryEntry(out, key, this.documentHash(doc));
      rec = this.store.get(doc.id);
      this.store.put({ ...rec, document: entry, sectionIndex: src.section?.index ?? null });
      this.log(
        `${doc.title}: document summary ${out.ok ? 'kept' : `dropped (${out.reason})`} in ${Date.now() - t0} ms`,
      );
    } else {
      const section = doc.sections.find((s) => s.index === job.sectionIndex);
      if (!section) return;
      const source = sectionSource(doc, section);
      const out = await this.generate((shorter) => sectionPrompt(doc, section, { shorter }), source, 'section', signal);
      if (signal.aborted) return;
      entry = summaryEntry(out, key, textHash(source));
      rec = this.store.get(doc.id);
      this.store.put({ ...rec, sections: { ...rec.sections, [String(section.index)]: entry } });
      if (!out.ok) this.log(`${doc.title} section ${section.index}: summary dropped (${out.reason})`);
    }
    // The button's estimate is for sections; a document summary reads more and is timed apart.
    if (job.level === 'section') {
      this.durations.push(Date.now() - t0);
      if (this.durations.length > 20) this.durations.shift();
    }
    this.d.onChange?.([doc.id]);
    this.scheduleExport();
  }

  /**
   * Several sections in one call. Each sentence is checked against its own section like a single
   * summary; a section the reply skipped or ran over the cap for is asked again on its own (with
   * the shorter retry), so a batch never keeps less than single calls would.
   */
  private async runBatch(doc: BrowseDocument, jobs: SummaryJob[], key: string, signal: AbortSignal): Promise<void> {
    const sections = jobs
      .map((j) => (j.level === 'section' ? doc.sections.find((s) => s.index === j.sectionIndex) : undefined))
      .filter((s): s is NonNullable<typeof s> => !!s);
    const t0 = Date.now();
    const reply = parseBatchReply(await this.ask(sectionBatchPrompt(doc, sections), signal), sections.length);
    if (signal.aborted) return;
    const entries: Record<string, StoredSummary> = {};
    const again: typeof sections = [];
    sections.forEach((section, i) => {
      const source = sectionSource(doc, section);
      const raw = reply.get(i + 1);
      const out = raw === undefined ? null : checkSummary(raw, source, 'section');
      if (!out || (!out.ok && out.reason !== 'unsupported')) again.push(section);
      else {
        entries[String(section.index)] = summaryEntry(out, key, textHash(source));
        if (!out.ok) this.log(`${doc.title} section ${section.index}: summary dropped (${out.reason})`);
      }
    });
    for (const section of again) {
      const source = sectionSource(doc, section);
      const out = await this.generate((shorter) => sectionPrompt(doc, section, { shorter }), source, 'section', signal);
      if (signal.aborted) return;
      entries[String(section.index)] = summaryEntry(out, key, textHash(source));
      if (!out.ok) this.log(`${doc.title} section ${section.index}: summary dropped (${out.reason})`);
    }
    const rec = this.store.get(doc.id);
    this.store.put({ ...rec, sections: { ...rec.sections, ...entries } });
    this.log(
      `${doc.title}: ${sections.length} sections in one call, ${again.length} asked again, ${Date.now() - t0} ms`,
    );
  }

  // --- reading --------------------------------------------------------------------------------

  /** Milliseconds per section summary: the measured pace of the last runs, else the default. */
  msPerSummary(): number {
    if (!this.durations.length) return DEFAULT_MS_PER_SECTION;
    return this.durations.reduce((a, b) => a + b, 0) / this.durations.length;
  }

  /** key: the version key, when the caller already has it (documentViews reads it once for all). */
  view(docId: string, key: string | null = this.key()): DocumentSummaryView | null {
    const doc = this.d.browse.getDocument({ id: docId });
    if (!doc) return null;
    const rec = this.store.get(docId);
    const sections: Record<string, string> = {};
    let missing = 0;
    let pending = 0;
    for (const s of doc.sections) {
      if (!s.text.trim()) continue;
      const ss = rec.sections[String(s.index)];
      const current = !!key && this.fresh(ss, key, textHash(sectionSource(doc, s)));
      if (ss?.status === 'ok' && ss.text) sections[String(s.index)] = ss.text;
      if (!current) {
        missing++;
        if (this.queue.has({ docId, level: 'section', sectionIndex: s.index, origin: 'document' })) pending++;
      }
    }
    const docEntry = rec.document;
    let state: DocumentSummaryView['state'];
    if (!key) state = docEntry?.status === 'ok' ? 'ok' : 'off';
    else if (docEntry?.status === 'ok') state = 'ok';
    else if (docEntry && this.fresh(docEntry, key, this.documentHash(doc))) state = 'none';
    else state = 'pending';
    return {
      documentId: docId,
      state,
      text: docEntry?.status === 'ok' ? docEntry.text : null,
      sectionIndex: rec.sectionIndex,
      sections,
      sectionsWanted: rec.sectionsWanted,
      sectionsPending: pending,
      sectionsMissing: missing,
      estimateMinutes: missing ? Math.max(1, Math.ceil((missing * this.msPerSummary()) / 60_000)) : 0,
    };
  }

  /** The document summary of every document, for the Library page and the overview's tooltips. */
  documentViews(): Record<string, { state: DocumentSummaryView['state']; text: string | null }> {
    const out: Record<string, { state: DocumentSummaryView['state']; text: string | null }> = {};
    const key = this.key();
    for (const d of this.d.browse.allDocuments()) {
      const v = this.view(d.id, key);
      if (v) out[d.id] = { state: v.state, text: v.text };
    }
    return out;
  }

  // --- export ---------------------------------------------------------------------------------

  scheduleExport(): void {
    if (this.exportTimer !== null) this.clearTimer(this.exportTimer);
    this.exportTimer = null;
    if (this.indexing) {
      this.exportWanted = true;
      return;
    }
    this.exportWanted = false;
    this.exportTimer = this.setTimer(() => {
      this.exportTimer = null;
      this.exportNow();
    }, this.d.exportDebounceMs ?? 2000);
  }

  exportNow(): { written: number; removed: number } | null {
    try {
      const files = exportFiles({
        docs: this.d.browse.allDocuments(),
        graph: this.d.graph(),
        summaries: (id) => this.store.get(id) ?? emptySummaries(id),
      });
      const r = writeExport(this.d.exportDir, files);
      if (r.written || r.removed) this.log(`export: ${r.written} written, ${r.removed} removed`);
      return r;
    } catch (e) {
      this.log(`export failed: ${(e as Error).message}`);
      return null;
    }
  }
}

function summaryEntry(out: CheckOutcome, key: string, sourceHash: string): StoredSummary {
  return {
    text: out.ok ? out.text : null,
    status: out.ok ? 'ok' : out.reason,
    key,
    sourceHash,
    at: new Date().toISOString(),
  };
}
