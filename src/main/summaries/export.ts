/**
 * The Markdown export of a library (docs/summaries.md, Export): an Obsidian-compatible folder at
 * <libraryDir>/export with one note per document (front matter with title, type, source path and
 * summary; its section summaries; [[links]] to the documents it references and to its shared
 * headings) and one note per shared heading under Headings/ listing each document's section
 * summary. Rewritten as summaries and files change; files it did not write are never touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowseDocument } from '../browse/types.js';
import type { GraphData } from '../graph/build.js';
import { edgeHeading } from '../graph/edges.js';
import type { DocumentSummaries } from './store.js';

/** The files the export wrote last time, so stale ones can go and the user's own stay. */
const MANIFEST = '.askfiles-export.json';
export const HEADINGS_FOLDER = 'Headings';

/** A file name Obsidian and every file system accept: no / \ : * ? " < > | # ^ [ ], at most 120 characters. */
export function safeName(name: string): string {
  const s = name
    .normalize('NFC')
    .replace(/[/\\:*?"<>|#^[\]]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return s || 'untitled';
}

/** YAML scalar: a JSON string is a valid double-quoted YAML string. */
const yaml = (v: string) => JSON.stringify(v);

function stem(title: string): string {
  return title.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/** Note names per document id: the file stem, with the extension added when two share a stem. */
export function noteNames(docs: { id: string; title: string }[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const d of docs) {
    const k = safeName(stem(d.title)).toLowerCase();
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const d of [...docs].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))) {
    const base = safeName(stem(d.title));
    const ext = path.extname(d.title).slice(1).toLowerCase();
    let name = count.get(base.toLowerCase())! > 1 && ext ? `${base} (${ext})` : base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    out.set(d.id, name);
  }
  return out;
}

export interface ExportInput {
  docs: BrowseDocument[];
  graph: GraphData;
  summaries: (id: string) => DocumentSummaries;
}

interface SharedHeading {
  key: string;
  label: string;
  /** Per document, its sections with this heading. */
  entries: { docId: string; sectionIndex: number; title: string }[];
}

function sharedHeadings(docs: BrowseDocument[]): SharedHeading[] {
  const map = new Map<string, SharedHeading>();
  const spell = new Map<string, Map<string, number>>();
  for (const d of docs) {
    for (const s of d.sections) {
      const key = edgeHeading(s.heading);
      if (!key) continue;
      const h = map.get(key) ?? { key, label: '', entries: [] };
      // One entry per document: the first section of the group in it.
      if (!h.entries.some((e) => e.docId === d.id))
        h.entries.push({ docId: d.id, sectionIndex: s.index, title: s.title });
      map.set(key, h);
      const sp = spell.get(key) ?? new Map<string, number>();
      const t = s.title.replace(/\s*\((?:page \d+|continued)\)\s*$/i, '').trim();
      sp.set(t, (sp.get(t) ?? 0) + 1);
      spell.set(key, sp);
    }
  }
  return [...map.values()]
    .filter((h) => h.entries.length >= 2)
    .map((h) => ({
      ...h,
      label: [...spell.get(h.key)!.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Every export file, by path relative to the export folder. */
export function exportFiles(input: ExportInput): Map<string, string> {
  const { docs, graph } = input;
  const names = noteNames(docs);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const shared = sharedHeadings(docs);
  const headingNames = new Map<string, string>();
  const usedHeading = new Set<string>();
  for (const h of shared) {
    let n = safeName(h.label);
    for (let i = 2; usedHeading.has(n.toLowerCase()); i++) n = `${safeName(h.label)} (${i})`;
    usedHeading.add(n.toLowerCase());
    headingNames.set(h.key, n);
  }
  const headingsOf = new Map<string, SharedHeading[]>();
  for (const h of shared) for (const e of h.entries) headingsOf.set(e.docId, [...(headingsOf.get(e.docId) ?? []), h]);
  const refs = graph.edges.filter((e) => e.kind === 'reference');
  const files = new Map<string, string>();

  for (const d of docs) {
    const s = input.summaries(d.id);
    const summary = s.document?.status === 'ok' ? s.document.text : null;
    const node = nodes.get(d.id);
    const fm = [
      '---',
      `title: ${yaml(d.title)}`,
      `type: ${yaml(node?.type ?? 'other')}`,
      `source: ${yaml(d.path)}`,
      ...(summary ? [`summary: ${yaml(summary)}`] : []),
      '---',
      '',
    ];
    const body = [`# ${d.title}`, ''];
    if (summary) body.push(summary, '');
    const sectionLines = d.sections
      .map((sec) => {
        const ss = s.sections[String(sec.index)];
        return ss?.status === 'ok' && ss.text ? `- **${sec.title.replace(/\s+/g, ' ')}**: ${ss.text}` : null;
      })
      .filter((l): l is string => !!l);
    if (sectionLines.length) body.push('## Sections', '', ...sectionLines, '');
    const out = new Map<string, number>();
    const inbound = new Map<string, number>();
    for (const e of refs) {
      // An edge keeps who referenced whom in its passages; both directions may be merged into one.
      for (const p of e.passages ?? []) {
        const other = p.documentId === e.source ? e.target : e.source;
        if (p.documentId === d.id) out.set(other, (out.get(other) ?? 0) + 1);
        else if (other === d.id) inbound.set(p.documentId, (inbound.get(p.documentId) ?? 0) + 1);
      }
    }
    const link = (id: string) => `[[${names.get(id)}]]`;
    const sortByName = (ids: string[]) =>
      ids.filter((id) => names.has(id)).sort((a, b) => names.get(a)!.localeCompare(names.get(b)!));
    if (out.size) body.push('## References', '', ...sortByName([...out.keys()]).map((id) => `- ${link(id)}`), '');
    if (inbound.size)
      body.push('## Referenced by', '', ...sortByName([...inbound.keys()]).map((id) => `- ${link(id)}`), '');
    const hs = headingsOf.get(d.id) ?? [];
    if (hs.length)
      body.push(
        '## Shared headings',
        '',
        ...hs.map((h) => `- [[${HEADINGS_FOLDER}/${headingNames.get(h.key)}|${h.label.replace(/[|\]]/g, ' ')}]]`),
        '',
      );
    files.set(`${names.get(d.id)}.md`, [...fm, ...body].join('\n'));
  }

  for (const h of shared) {
    const lines = ['---', `heading: ${yaml(h.label)}`, `documents: ${h.entries.length}`, '---', '', `# ${h.label}`, ''];
    for (const e of [...h.entries].sort((a, b) => names.get(a.docId)!.localeCompare(names.get(b.docId)!))) {
      const ss = input.summaries(e.docId).sections[String(e.sectionIndex)];
      lines.push(
        `## [[${names.get(e.docId)}]]`,
        '',
        ss?.status === 'ok' && ss.text ? ss.text : 'No section summary yet.',
        '',
      );
    }
    files.set(`${HEADINGS_FOLDER}/${headingNames.get(h.key)}.md`, lines.join('\n'));
  }
  return files;
}

/** Writes what changed, removes the files of the last export that are gone. Returns the counts. */
export function writeExport(dir: string, files: Map<string, string>): { written: number; removed: number } {
  fs.mkdirSync(path.join(dir, HEADINGS_FOLDER), { recursive: true });
  let before: string[] = [];
  try {
    before = (JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as { files?: string[] }).files ?? [];
  } catch {
    // First export.
  }
  let written = 0;
  for (const [rel, content] of files) {
    const file = path.join(dir, rel);
    let old: string | null = null;
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch {
      // New file.
    }
    if (old === content) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    written++;
  }
  let removed = 0;
  for (const rel of before) {
    if (files.has(rel) || rel.includes('..') || path.isAbsolute(rel)) continue;
    fs.rmSync(path.join(dir, rel), { force: true });
    removed++;
  }
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ files: [...files.keys()].sort() }));
  return { written, removed };
}
