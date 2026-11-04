import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../graph/build.js';
import { loadProfiles, profileFor } from '../graph/profiles.js';
import { doc } from '../graph/__fixtures__/docs.js';
import { exportFiles, noteNames, safeName, writeExport } from './export.js';
import { emptySummaries, type DocumentSummaries } from './store.js';

const profile = profileFor(
  loadProfiles(path.resolve(import.meta.dirname, '../../../config/profiles')),
  'legal-finance',
);

/** Front matter of a note as an object; values are JSON strings or numbers, as the export writes them. */
export function frontMatter(note: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(note);
  if (!m) throw new Error('no front matter');
  return Object.fromEntries(
    m[1]!.split('\n').map((l) => {
      const i = l.indexOf(': ');
      return [l.slice(0, i), JSON.parse(l.slice(i + 2))];
    }),
  );
}

const links = (note: string) => [...note.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);

let tmp: string | null = null;
afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

describe('markdown export', () => {
  const regs = doc('Procurement Regulations 2025.pdf', [
    ['Scope', 'These rules apply to all procurement.'],
    ['Definitions', 'Terms used.'],
  ]);
  const guide = doc('Value for Money Guidance.pdf', [
    ['Scope', 'This guidance applies the Procurement Regulations.'],
    ['Definitions', 'More terms.'],
  ]);
  const sums: Record<string, DocumentSummaries> = {
    [regs.id]: {
      ...emptySummaries(regs.id),
      document: {
        text: 'The regulations set the rules for procurement.',
        status: 'ok',
        key: 'm|p1',
        sourceHash: 'x',
        at: 't',
      },
      sections: {
        '1': { text: 'The rules apply to all procurement.', status: 'ok', key: 'm|p1', sourceHash: 'y', at: 't' },
      },
    },
  };
  const input = () => ({
    docs: [regs, guide],
    graph: buildGraph([regs, guide], { profile }),
    summaries: (id: string) => sums[id] ?? emptySummaries(id),
  });

  it('writes one note per document with front matter and [[links]], and one note per shared heading', () => {
    const files = exportFiles(input());
    expect([...files.keys()].sort()).toEqual([
      'Headings/Definitions.md',
      'Headings/Scope.md',
      'Procurement Regulations 2025.md',
      'Value for Money Guidance.md',
    ]);
    const r = files.get('Procurement Regulations 2025.md')!;
    expect(frontMatter(r)).toEqual({
      title: 'Procurement Regulations 2025.pdf',
      type: 'regulation',
      source: regs.path,
      summary: 'The regulations set the rules for procurement.',
    });
    expect(r).toContain('- **Scope**: The rules apply to all procurement.');
    expect(links(r)).toEqual(['Value for Money Guidance', 'Headings/Definitions', 'Headings/Scope']);
    const g = files.get('Value for Money Guidance.md')!;
    expect(frontMatter(g)).toMatchObject({ type: 'guidance' });
    expect(frontMatter(g).summary).toBeUndefined();
    expect(g).toMatch(/## References\n\n- \[\[Procurement Regulations 2025\]\]/);
    const scope = files.get('Headings/Scope.md')!;
    expect(frontMatter(scope)).toEqual({ heading: 'Scope', documents: 2 });
    expect(links(scope)).toEqual(['Procurement Regulations 2025', 'Value for Money Guidance']);
    // No summaries on a heading note, as on the Compare page.
    expect(scope).not.toContain('The rules apply to all procurement.');
    expect(scope).not.toContain('No section summary yet.');
  });

  it('names notes safely and tells two formats of one stem apart', () => {
    expect(safeName('a/b: c?')).toBe('a-b- c-');
    const n = noteNames([
      { id: '1', title: 'Rules.pdf' },
      { id: '2', title: 'Rules.docx' },
      { id: '3', title: 'Other.md' },
    ]);
    expect([...n.values()].sort()).toEqual(['Other', 'Rules (docx)', 'Rules (pdf)']);
  });

  it('rewrites only what changed and removes its own stale notes, never the user files', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-export-'));
    const files = exportFiles(input());
    expect(writeExport(tmp, files)).toEqual({ written: 4, removed: 0 });
    fs.writeFileSync(path.join(tmp, 'My own note.md'), 'mine');
    expect(writeExport(tmp, files)).toEqual({ written: 0, removed: 0 });
    const fewer = exportFiles({ ...input(), docs: [regs], graph: buildGraph([regs], { profile }) });
    expect(writeExport(tmp, fewer)).toEqual({ written: 1, removed: 3 });
    expect(fs.existsSync(path.join(tmp, 'Value for Money Guidance.md'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'My own note.md'), 'utf8')).toBe('mine');
  });
});
