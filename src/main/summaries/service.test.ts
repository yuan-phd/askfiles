import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFn } from '../answer/ollama-chat.js';
import { BrowseIndex } from '../browse/browse-index.js';
import type { FileRecord } from '../watcher/index.js';
import { buildGraph } from '../graph/build.js';
import { loadProfiles, profileFor } from '../graph/profiles.js';
import { SummaryService, type SummaryModel } from './service.js';

const profile = profileFor(
  loadProfiles(path.resolve(import.meta.dirname, '../../../config/profiles')),
  'legal-finance',
);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-summaries-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A browse index over in-memory section documents: record(path, sections) indexes a file. */
function library() {
  const chunks = new Map<string, string>();
  const index = new BrowseIndex({
    dir: path.join(tmp, 'browse'),
    readChunk: (loc) => (chunks.has(loc) ? { pageContent: chunks.get(loc)!, sectionLevel: 1 } : null),
    log: () => {},
  });
  const record = (file: string, sections: [string, string][], hash = 'h1'): FileRecord => {
    sections.forEach(([t, body], i) => chunks.set(`${file}-${i}-${hash}`, `${t}\n${body}`));
    return {
      path: file,
      url: `file://${file}`,
      relPath: path.basename(file),
      sourceId: 'files',
      hash,
      splitKey: 'k',
      size: 10,
      mtimeMs: 1,
      indexedAt: '2026-11-04T00:00:00Z',
      sections: sections.map(([t], i) => ({
        location: `${file}-${i}-${hash}`,
        docId: null,
        sectionTitle: t,
        sectionIndex: i + 1,
        sectionLevel: 1,
        sectionPath: [t],
        subIndex: 1,
        pageStart: null,
        pageEnd: null,
      })),
    } as unknown as FileRecord;
  };
  return { index, record };
}

/** A chat that answers with the first sentence of the user message after its header lines. */
function echoChat() {
  const calls: { model: string; content: string; num: number }[] = [];
  const chat: ChatFn = async (o, onText) => {
    const user = o.messages.find((m) => m.role === 'user')!.content;
    calls.push({ model: o.model, content: user, num: o.contextLength });
    const body = user
      .split('\n')
      .filter((l) => !/^(Title|Outline|First section|Document|Section):?/.test(l))
      .join(' ');
    onText(body.split(/(?<=\.)\s/)[0]!);
    return { promptTokens: null, completionTokens: null };
  };
  return { chat, calls };
}

function service(index: BrowseIndex, chat: ChatFn, o: { model?: SummaryModel | null; library?: () => boolean } = {}) {
  const model = o.model === undefined ? { model: 'qwen3:14b', contextLength: 8192, temperature: 0.1 } : o.model;
  let current = model;
  const changed: string[][] = [];
  const s = new SummaryService({
    browse: index,
    dir: path.join(tmp, 'summaries'),
    exportDir: path.join(tmp, 'export'),
    chat,
    model: () => current,
    librarySections: o.library ?? (() => false),
    graph: () => buildGraph(index.allDocuments(), { profile }),
    onChange: (ids) => changed.push(ids),
    idleMs: 1000,
    exportDebounceMs: 100,
  });
  return { s, changed, setModel: (m: SummaryModel | null) => (current = m) };
}

const LEAVE: [string, string][] = [
  ['Annual leave', 'Permanent employees receive 27 days of paid annual leave per calendar year.'],
  ['Sick leave', 'Employees who are ill notify their manager before ten on the first day of absence.'],
];

describe('summary service', () => {
  it('summarizes a document after it is indexed, cited to its first section, and exports it', async () => {
    const { index, record } = library();
    const { chat, calls } = echoChat();
    const { s, changed } = service(index, chat);
    index.update(record('/d/leave.md', LEAVE));
    expect(s.status()).toMatchObject({ state: 'waiting', total: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(200);
    const id = index.allDocuments()[0]!.id;
    expect(s.view(id)).toMatchObject({
      state: 'ok',
      text: 'Permanent employees receive 27 days of paid annual leave per calendar year.',
      sectionIndex: 1,
      sectionsMissing: 2,
    });
    expect(calls[0]).toMatchObject({ model: 'qwen3:14b', num: 8192 });
    expect(changed).toContainEqual([id]);
    const note = fs.readFileSync(path.join(tmp, 'export', 'leave.md'), 'utf8');
    expect(note).toContain('summary: "Permanent employees receive 27 days');
    s.stop();
  });

  it('section summaries on request: only changed sections are redone after a file change', async () => {
    const { index, record } = library();
    const { chat, calls } = echoChat();
    const { s } = service(index, chat);
    index.update(record('/d/leave.md', LEAVE));
    const id = index.allDocuments()[0]!.id;
    s.requestSections(id);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(3);
    expect(Object.keys(s.view(id)!.sections)).toEqual(['1', '2']);
    // The file changes in its second section only.
    index.update(
      record(
        '/d/leave.md',
        [LEAVE[0]!, ['Sick leave', 'Employees who are ill call their manager on the first day.']],
        'h2',
      ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(50);
    const again = calls.slice(3).map((c) => c.content.split('\n')[1]);
    // The document summary (its source holds the outline) and the changed section; not section 1.
    expect(again.sort()).toEqual(['Outline: Annual leave; Sick leave', 'Section: Sick leave'].sort());
    expect(s.view(id)!.sections['2']).toBe('Employees who are ill call their manager on the first day.');
    s.stop();
  });

  it('removes the summaries of a removed file, and its export note', async () => {
    const { index, record } = library();
    const { s } = service(index, echoChat().chat);
    index.update(record('/d/leave.md', LEAVE));
    const id = index.allDocuments()[0]!.id;
    await vi.advanceTimersByTimeAsync(1300);
    expect(fs.existsSync(path.join(tmp, 'summaries', `${id}.json`))).toBe(true);
    index.remove('/d/leave.md');
    await vi.advanceTimersByTimeAsync(200);
    expect(fs.existsSync(path.join(tmp, 'summaries', `${id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'export', 'leave.md'))).toBe(false);
    s.stop();
  });

  it('marks summaries stale when the model changes, and makes none on a tier without a model', async () => {
    const { index, record } = library();
    const { chat, calls } = echoChat();
    const { s, setModel } = service(index, chat);
    index.update(record('/d/leave.md', LEAVE));
    await vi.advanceTimersByTimeAsync(1300);
    expect(calls).toHaveLength(1);
    setModel({ model: 'qwen3:8b', contextLength: 8192, temperature: 0.1 });
    s.modelChanged();
    await vi.advanceTimersByTimeAsync(1300);
    expect(calls.map((c) => c.model)).toEqual(['qwen3:14b', 'qwen3:8b']);
    setModel(null);
    s.modelChanged();
    const id = index.allDocuments()[0]!.id;
    expect(s.status()).toMatchObject({ enabled: false });
    // Kept summaries stay readable; nothing new is made.
    expect(s.view(id)!.state).toBe('ok');
    index.update(record('/d/other.md', LEAVE));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
    expect(s.view(index.allDocuments().find((d) => d.title === 'other.md')!.id)!.state).toBe('off');
    s.stop();
  });

  it('the library switch summarizes every section, also of documents added later', async () => {
    const { index, record } = library();
    const { chat, calls } = echoChat();
    let on = false;
    const { s } = service(index, chat, { library: () => on });
    index.update(record('/d/a.md', LEAVE));
    await vi.advanceTimersByTimeAsync(1300);
    expect(calls).toHaveLength(1);
    on = true;
    s.librarySectionsChanged();
    index.update(record('/d/b.md', LEAVE));
    await vi.advanceTimersByTimeAsync(1300);
    // a: 2 sections; b: its summary and 2 sections.
    expect(calls).toHaveLength(6);
    s.stop();
  });

  it('drops a summary the source does not support and does not ask again', async () => {
    const { index, record } = library();
    const calls: number[] = [];
    const chat: ChatFn = async (_o, onText) => {
      calls.push(1);
      onText('This document describes pension schemes and company cars for directors.');
      return { promptTokens: null, completionTokens: null };
    };
    const { s } = service(index, chat);
    index.update(record('/d/leave.md', LEAVE));
    await vi.advanceTimersByTimeAsync(1300);
    const id = index.allDocuments()[0]!.id;
    expect(s.view(id)).toMatchObject({ state: 'none', text: null });
    s.reconcile();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);
    s.stop();
  });
});
