/**
 * The test build's question record (docs/test-build.md): one JSON line per event in
 * <data directory>/test-record/record.jsonl, settings beside it in settings.json. Nothing here
 * makes a network call; the record leaves the machine only when the tester exports it and sends
 * the file. The release build does not contain this folder (scripts/check-test-record.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AnsweredRun } from '../answer/service.js';

/** Searched for by scripts/check-test-record.mjs in the packaged release app; it must find nothing. */
export const MODULE_MARKER = 'askfiles-test-record-module';

/** Version of the line format; docs/test-build.md describes each field. */
export const RECORD_VERSION = 1;

export const RECORD_FILE = 'record.jsonl';
export const SETTINGS_FILE = 'settings.json';

export type Outcome = 'answer' | 'refusal' | 'error' | 'cancelled';

export interface CitedSource {
  file: string;
  /** The display name the source card showed first; null when the card showed the file name. */
  display: string | null;
  /** Heading path of the section, joined with " > ". */
  section: string;
  page: number | null;
}

export interface QuestionRecord {
  v: number;
  type: 'question';
  time: string;
  library: string | null;
  question: string;
  switches: {
    /** questionFileNames: the question the model read differs from the one typed. */
    questionRewrite: { fired: boolean; sent: string | null };
    /** Named-file detection: the question names two or more files (crossDocQuota). */
    namedFiles: { fired: boolean; files: string[] };
    /** Per-file quota: sections taken from inside each named file. */
    perFileQuota: { fired: boolean; sections: number };
    /** judgeRerank: the chat model judged each named file's candidates. */
    judgeRerank: { fired: boolean; files: number; ms: number };
  };
  outcome: Outcome;
  error: string | null;
  answer: string | null;
  cited: CitedSource[];
  /** Sentences shown with the asterisk (no source found for them). */
  starred: number;
  totalMs: number;
}

export interface AddRecord {
  v: number;
  type: 'add';
  time: string;
  library: string | null;
  /** files: the Add files dialog; folder: the Add folder dialog; drop: files or folders dragged in. */
  kind: 'files' | 'folder' | 'drop';
  /** Files copied or folders linked; a folder counts as one. */
  added: number;
  skipped: number;
}

export interface BrowseRecord {
  v: number;
  type: 'browse';
  time: string;
  library: string | null;
  /** The Browse page: library, document, compare, find or graph. */
  page: string;
  /** The document's title on the document page; null on the others. */
  document: string | null;
}

export interface SourceRecord {
  v: number;
  type: 'source';
  time: string;
  library: string | null;
  /** open: Show in Finder (or Explorer); read: the section on the Browse document page. */
  action: 'open' | 'read';
  file: string;
  section: string | null;
  page: number | null;
}

export type RecordLine = QuestionRecord | AddRecord | BrowseRecord | SourceRecord;

export type ExportMode = 'questions' | 'full';

export interface RecordSettings {
  paused: boolean;
  noticeShown: boolean;
}

export interface RecordStatus extends RecordSettings {
  /** Lines in the record. */
  events: number;
  questions: number;
  file: string;
}

/** The question record of a finished run. */
export function questionRecord(run: AnsweredRun, library: string | null, now: Date): QuestionRecord {
  const r = run.result;
  const cd = run.retrieval?.crossDocument;
  const sent = r?.questionSent && r.questionSent !== run.question ? r.questionSent : null;
  const outcome: Outcome = run.cancelled
    ? 'cancelled'
    : run.error !== null || !r
      ? 'error'
      : r.notFound
        ? 'refusal'
        : 'answer';
  const judged = cd?.judge?.files.length ?? 0;
  return {
    v: RECORD_VERSION,
    type: 'question',
    time: now.toISOString(),
    library,
    question: run.question,
    switches: {
      questionRewrite: { fired: sent !== null, sent },
      namedFiles: { fired: !!cd, files: cd?.files ?? [] },
      perFileQuota: { fired: (cd?.quota.length ?? 0) > 0, sections: cd?.quota.length ?? 0 },
      judgeRerank: { fired: judged > 0, files: judged, ms: Math.round(cd?.judge?.ms ?? 0) },
    },
    outcome,
    error: outcome === 'error' ? (run.error ?? 'no answer') : null,
    answer: r && outcome !== 'cancelled' ? r.text : null,
    cited: (r?.cited ?? []).map((c) => ({
      file: c.file,
      display: c.display && c.display !== c.file ? c.display : null,
      section: (c.path.length ? c.path : [c.title]).filter(Boolean).join(' > '),
      page: c.pageStart,
    })),
    starred: r && !r.notFound ? r.claims.filter((c) => c.unsupported).length : 0,
    totalMs: run.totalMs,
  };
}

const MAX_TEXT = 1000;
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);
const BROWSE_PAGES = new Set(['library', 'document', 'compare', 'find', 'graph']);

/**
 * A Browse or source card event from a page (window.askfilesTest.record), checked field by field:
 * a page can send anything, so only the known shapes are kept, and nothing else of what it sent.
 */
export function pageRecord(input: unknown, library: string | null, now: Date): BrowseRecord | SourceRecord | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const base = { v: RECORD_VERSION, time: now.toISOString(), library };
  if (o.type === 'browse') {
    const page = text(o.page);
    if (!page || !BROWSE_PAGES.has(page)) return null;
    return { ...base, type: 'browse', page, document: page === 'document' ? text(o.document) : null };
  }
  if (o.type === 'source') {
    const file = text(o.file);
    if (!file || (o.action !== 'open' && o.action !== 'read')) return null;
    const page = typeof o.page === 'number' && Number.isInteger(o.page) && o.page > 0 ? o.page : null;
    return { ...base, type: 'source', action: o.action, file, section: text(o.section), page };
  }
  return null;
}

/**
 * The lines an export writes. questions: each question with its switches, outcome, counts and
 * time, without the answer, the cited files and sections or the error text; action lines without
 * document, file and section names. full: every line as recorded.
 */
export function exportLine(line: RecordLine, mode: ExportMode): RecordLine {
  if (mode === 'full') return line;
  switch (line.type) {
    case 'question':
      return { ...line, answer: null, cited: [], error: null };
    case 'browse':
      return { ...line, document: null };
    case 'source':
      return { ...line, file: '', section: null, page: null };
    default:
      return line;
  }
}

/** Reads the lines of a record file; a damaged line (a crash mid-write) is skipped. */
export function readRecord(file: string): RecordLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: RecordLine[] = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as RecordLine);
    } catch {
      // skipped
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface ExportInfo {
  version: string;
  platform: string;
}

export class TestRecord {
  readonly file: string;
  private readonly settingsFile: string;
  private settings: RecordSettings;
  private readonly now: () => Date;

  constructor(
    readonly dir: string,
    o: { now?: () => Date; log?: (m: string) => void } = {},
  ) {
    this.file = path.join(dir, RECORD_FILE);
    this.settingsFile = path.join(dir, SETTINGS_FILE);
    this.now = o.now ?? (() => new Date());
    this.settings = { paused: false, noticeShown: false };
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) as Partial<RecordSettings>;
      this.settings = { paused: s.paused === true, noticeShown: s.noticeShown === true };
    } catch {
      // first start of a test build
    }
  }

  private saveSettings(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2) + '\n');
  }

  status(): RecordStatus {
    const lines = readRecord(this.file);
    return {
      ...this.settings,
      events: lines.length,
      questions: lines.filter((l) => l.type === 'question').length,
      file: this.file,
    };
  }

  /** Appends one line; false while recording is paused. */
  append(line: RecordLine): boolean {
    if (this.settings.paused) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
    return true;
  }

  setPaused(paused: boolean): RecordStatus {
    this.settings.paused = paused;
    this.saveSettings();
    return this.status();
  }

  noticeShown(): RecordStatus {
    this.settings.noticeShown = true;
    this.saveSettings();
    return this.status();
  }

  /** Deletes every recorded line; the settings stay. */
  clear(): RecordStatus {
    fs.rmSync(this.file, { force: true });
    return this.status();
  }

  /**
   * Writes the record to one new file in dir (the Desktop) and returns its path. The first line
   * says what the file is; the others are the record's lines as exportLine gives them.
   */
  export(mode: ExportMode, outDir: string, info: ExportInfo): string {
    const now = this.now();
    const base = `AskFiles test record ${mode === 'full' ? 'with answers' : 'questions only'} ${stamp(now)}`;
    let file = path.join(outDir, `${base}.jsonl`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(outDir, `${base} (${i}).jsonl`);
    const lines = readRecord(this.file);
    const header = {
      v: RECORD_VERSION,
      type: 'export',
      mode,
      exportedAt: now.toISOString(),
      app: info.version,
      platform: info.platform,
      lines: lines.length,
    };
    const body = [header, ...lines.map((l) => exportLine(l, mode))].map((l) => JSON.stringify(l)).join('\n') + '\n';
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, body, { flag: 'wx' });
    return file;
  }
}
