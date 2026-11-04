import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowseChange, BrowseIndex } from '../browse/index.js';
import { doc } from './__fixtures__/docs.js';
import { loadProfiles, profileFor } from './profiles.js';
import { GraphService } from './service.js';

const profile = profileFor(
  loadProfiles(path.resolve(import.meta.dirname, '../../../config/profiles')),
  'legal-finance',
);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-graph-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeBrowse() {
  const docs = [doc('a.md', [['Scope', 'Text.']])];
  let listener: (c: BrowseChange) => void = () => {};
  const browse = {
    allDocuments: () => docs,
    onChange: (l: (c: BrowseChange) => void) => {
      listener = l;
      return () => {};
    },
  } as unknown as BrowseIndex;
  return { browse, docs, change: () => listener({ type: 'update', id: 'x', sections: true }) };
}

describe('GraphService', () => {
  it('rebuilds once after a batch of files instead of after every file', async () => {
    const { browse, docs, change } = fakeBrowse();
    const built: number[] = [];
    const g = new GraphService({
      browse,
      file: path.join(tmp, 'graph.json'),
      options: () => ({ profile, overrides: {}, familyDecisions: {} }),
      onChange: (graph) => built.push(graph.nodes.length),
      debounceMs: 10,
    });
    change();
    await vi.advanceTimersByTimeAsync(20);
    expect(built).toEqual([1]);
    g.setIndexing(true);
    for (const t of ['b.md', 'c.md', 'd.md']) {
      docs.push(doc(t, [['Scope', 'Text.']]));
      change();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(built).toEqual([1]);
    // A page asking during the batch still gets the current graph.
    expect(g.data().nodes).toHaveLength(4);
    docs.push(doc('e.md', [['Scope', 'Text.']]));
    change();
    g.setIndexing(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(built).toEqual([1, 5]);
    g.stop();
  });
});
