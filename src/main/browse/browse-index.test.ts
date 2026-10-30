import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countingSplitter, fakeApi, manualWatch } from '../watcher/__fixtures__/fakes.js';
import { FolderWatcher } from '../watcher/watcher.js';
import { BrowseIndex, chunkReader, followWatcher, snippetOf, splitHead } from './index.js';

let tmp: string;
let root: string;
let dataDir: string;
let storageDir: string;
let watcher: FolderWatcher;
let watch: ReturnType<typeof manualWatch>;
let index: BrowseIndex;

const LONG = Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i + 1} of the travel rules, long enough to matter.`,
).join('\n\n');

const HANDBOOK = `# Employee Handbook

## 1. Annual Leave

Employees get 27 days of paid annual leave per year.

## 2. Sick Leave

Sick leave needs a note after three days.

### 2.1 Long illness

Long illness is handled by HR.

## 3. Travel

${LONG}
`;

const POLICY = `# 第一章 总则

本制度适用于全体员工。

# 第二章 年假

员工每年享有带薪年假二十七天。

## Annual leave：

Leave must be booked in the HR system.
`;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-browse-')));
  root = path.join(tmp, 'Documents');
  dataDir = path.join(tmp, 'data');
  storageDir = path.join(dataDir, 'storage');
  fs.mkdirSync(root);
  watch = manualWatch();
  watcher = new FolderWatcher({
    root,
    dataDir,
    storageDir,
    workspaceSlug: 'library',
    api: fakeApi(storageDir),
    splitter: countingSplitter(400),
    watch,
    debounceMs: 20,
    stableMs: 20,
    log: () => {},
  });
  index = new BrowseIndex({
    dir: path.join(dataDir, 'browse'),
    root,
    readChunk: chunkReader(storageDir),
    log: () => {},
  });
  followWatcher(index, watcher);
  await watcher.start();
  index.sync(watcher.files());
});

afterEach(async () => {
  await watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function put(name: string, text: string): Promise<string> {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  watch.emit('add', p);
  await watcher.whenIdle();
  return p;
}

async function del(p: string): Promise<void> {
  fs.rmSync(p);
  watch.emit('unlink', p);
  await watcher.whenIdle();
}

describe('splitHead and snippets', () => {
  it('takes the folded headings and the title off the chunk text', () => {
    expect(splitHead('Chapter 1\nScope\nBody line\nmore', 'Scope')).toEqual({
      lead: ['Chapter 1'],
      body: 'Body line\nmore',
    });
    expect(splitHead('Scope\nBody', '  Scope ')).toEqual({ lead: [], body: 'Body' });
    expect(splitHead('No head here', 'Scope')).toEqual({ lead: [], body: 'No head here' });
  });

  it('marks every term inside the snippet at its place in the original text', () => {
    const { snippet, marks } = snippetOf('员工每年享有带薪年假二十七天。Ａｎｎｕａｌ leave too.', ['年假', 'annual']);
    expect(marks.map(([a, b]) => snippet.slice(a, b))).toEqual(['年假', 'Ａｎｎｕａｌ']);
    const long = `${'x '.repeat(100)}needle ${'y '.repeat(200)}`;
    const s = snippetOf(long, ['needle']);
    expect(s.snippet.startsWith('...')).toBe(true);
    expect(s.snippet.endsWith('...')).toBe(true);
    expect(s.snippet.slice(s.marks[0]![0], s.marks[0]![1])).toBe('needle');
  });
});

describe('BrowseIndex', () => {
  it('builds a document with its nested outline and whole sections', async () => {
    const p = await put('hr/handbook.md', HANDBOOK);
    const [summary] = index.listDocuments();
    expect(summary).toMatchObject({ title: 'handbook.md', relPath: path.join('hr', 'handbook.md'), path: p });
    expect(summary!.size).toBe(fs.statSync(p).size);

    const doc = index.getDocument({ id: summary!.id })!;
    // The top heading has no text of its own, so the splitter folds it into the first section.
    expect(doc.sections.map((s) => [s.index, s.title, s.level, s.lead])).toEqual([
      [1, '1. Annual Leave', 2, ['Employee Handbook']],
      [2, '2. Sick Leave', 2, []],
      [3, '2.1 Long illness', 3, []],
      [4, '3. Travel', 2, []],
    ]);
    const tree = (es: typeof doc.outline): unknown[] =>
      es.map((e) => (e.children.length ? [e.title, e.sectionIndex, tree(e.children)] : [e.title, e.sectionIndex]));
    expect(tree(doc.outline)).toEqual([
      [
        'Employee Handbook',
        1,
        [
          ['1. Annual Leave', 1],
          ['2. Sick Leave', 2, [['2.1 Long illness', 3]]],
          ['3. Travel', 4],
        ],
      ],
    ]);
    expect(doc.sections[0]!.text).toBe('Employees get 27 days of paid annual leave per year.');
    // Travel is longer than the chunk maximum: its sub-chunks are joined back, titles taken off.
    const recs = watcher.file(p)!.sections.filter((s) => s.sectionIndex === 4);
    expect(recs.length).toBeGreaterThan(1);
    expect(doc.sections[3]!.text).toBe(LONG);
    expect(doc.sections[0]!.heading).toBe('annual leave');
  });

  it('finds a document by id, by url and by a unique file name', async () => {
    const p = await put('handbook.md', HANDBOOK);
    const id = index.listDocuments()[0]!.id;
    expect(index.getDocument({ url: `file://${p}` })?.id).toBe(id);
    expect(index.getDocument({ url: 'file:///elsewhere/x.md', title: 'handbook.md' })?.id).toBe(id);
    expect(index.getDocument({ title: 'other.md' })).toBeNull();
    expect(index.getDocument({ id: 'nope' })).toBeNull();
  });

  it('groups the same heading across documents, Chinese and English', async () => {
    await put('handbook.md', HANDBOOK);
    await put('制度.md', POLICY);
    await put('old/handbook-v1.md', HANDBOOK.replace('27 days', '25 days'));
    const groups = index.headings();
    const leave = groups.find((g) => g.key === 'annual leave')!;
    expect(leave.documents).toBe(3);
    expect(leave.label).toBe('1. Annual Leave');
    expect(leave.entries.map((e) => [e.documentTitle, e.title])).toEqual([
      ['handbook.md', '1. Annual Leave'],
      ['handbook-v1.md', '1. Annual Leave'],
      ['制度.md', 'Annual leave：'],
    ]);
    expect(leave.entries[0]!.text).toBeUndefined();
    expect(groups[0]!.documents).toBe(3);
    expect(groups.find((g) => g.key === '年假')!.entries[0]!.title).toBe('第二章 年假');
    expect(groups.find((g) => g.key === '总则')!.documents).toBe(1);

    const [one] = index.headings({ key: 'annual leave' });
    expect(one!.entries.map((e) => e.text)).toEqual([
      'Employees get 27 days of paid annual leave per year.',
      'Employees get 25 days of paid annual leave per year.',
      'Leave must be booked in the HR system.',
    ]);
    expect(index.headings({ key: 'no such heading' })).toEqual([]);
  });

  it('leaves text before the first heading and page sections out of the heading index', async () => {
    await put('notes.txt', 'Just some notes without headings.');
    expect(index.headings()).toEqual([]);
    expect(index.listDocuments()[0]!.outline).toEqual([]);
  });

  it('searches section text, English and Chinese, grouped by document and section', async () => {
    await put('handbook.md', HANDBOOK);
    await put('制度.md', POLICY);

    const en = index.search('annual LEAVE');
    expect(en.terms).toEqual(['annual', 'leave']);
    expect(en.groups.map((g) => g.document.title)).toEqual(['handbook.md', '制度.md']);
    expect(en.groups[0]!.hits.map((h) => h.title)).toEqual(['1. Annual Leave']);
    const hit = en.groups[0]!.hits[0]!;
    expect(hit.marks.map(([a, b]) => hit.snippet.slice(a, b))).toEqual(['annual', 'leave']);

    // No word boundaries in Chinese: a run of characters inside a sentence matches.
    const zh = index.search('年假');
    expect(zh.groups).toHaveLength(1);
    expect(zh.groups[0]!.document.title).toBe('制度.md');
    expect(zh.groups[0]!.hits.map((h) => [h.sectionIndex, h.title])).toEqual([[2, '第二章 年假']]);
    expect(zh.groups[0]!.hits[0]!.snippet).toContain('带薪年假二十七天');
    expect(index.search('带薪年假').total).toBe(1);
    expect(index.search('全体员工 适用').groups[0]!.hits[0]!.title).toBe('第一章 总则');

    // Full-width query, every term required, substring inside a word.
    expect(index.search('ＡＮＮＵＡＬ').total).toBe(2);
    expect(index.search('annual cake').total).toBe(0);
    expect(index.search('illn').groups[0]!.hits[0]!.title).toBe('2.1 Long illness');
    expect(index.search('   ').groups).toEqual([]);
  });

  it('caps the hits and says so', async () => {
    await put('handbook.md', HANDBOOK);
    const r = index.search('paragraph', 0);
    expect(r).toMatchObject({ total: 1, truncated: true, groups: [] });
  });

  it('follows add, change and delete events and keeps its files in the data directory', async () => {
    const p = await put('handbook.md', HANDBOOK);
    const id = index.listDocuments()[0]!.id;
    const file = path.join(dataDir, 'browse', `${id}.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sections).toHaveLength(4);

    await put('handbook.md', HANDBOOK.replace('27 days', '30 days').replace('## 3. Travel', '## 3. Expenses'));
    const doc = index.getDocument({ id })!;
    expect(doc.sections[0]!.text).toContain('30 days');
    expect(doc.sections.map((s) => s.title)).toContain('3. Expenses');
    expect(index.search('27 days').total).toBe(0);
    expect(index.search('30 days').total).toBe(1);
    expect(doc.hash).toBe(watcher.file(p)!.hash);

    // A fresh index reads what was stored.
    const again = new BrowseIndex({ dir: path.join(dataDir, 'browse'), root, readChunk: () => null, log: () => {} });
    again.load();
    expect(again.getDocument({ id })!.sections[0]!.text).toContain('30 days');

    await del(p);
    expect(index.listDocuments()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(index.search('30 days').total).toBe(0);
  });

  it('sync builds what is missing and drops what the watcher no longer has', async () => {
    await put('handbook.md', HANDBOOK);
    const stale = new BrowseIndex({
      dir: path.join(tmp, 'other'),
      root,
      readChunk: chunkReader(storageDir),
      log: () => {},
    });
    stale.sync(watcher.files());
    expect(stale.listDocuments()).toHaveLength(1);
    stale.sync([]);
    expect(stale.listDocuments()).toEqual([]);
    expect(fs.readdirSync(path.join(tmp, 'other'))).toEqual([]);
  });
});
