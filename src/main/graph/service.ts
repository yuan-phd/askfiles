/**
 * Keeps the current library's library graph: built on the first request, rebuilt after the browse
 * index changes (the watcher's file events reach it through BrowseIndex.onChange) and after the
 * library's profile, type overrides or family answers change. Stored as <libraryDir>/graph.json, so
 * the smoke test can see it and the next launch has it before the first rebuild.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowseIndex } from '../browse/index.js';
import { buildGraph, type GraphData } from './build.js';
import type { Profile } from './profiles.js';

export interface GraphServiceDeps {
  browse: BrowseIndex;
  /** <libraryDir>/graph.json */
  file: string;
  /** Read at every build, so a change to the library record applies at the next one. */
  options(): { profile: Profile; overrides: Record<string, string>; familyDecisions: Record<string, boolean> };
  /** Called after a rebuild that follows a change, debounced. */
  onChange?(graph: GraphData): void;
  debounceMs?: number;
  log?: (msg: string) => void;
}

export class GraphService {
  private graph: GraphData | null = null;
  private dirty = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly off: () => void;
  private readonly log: (msg: string) => void;
  /** While the library indexes, changes only mark the graph stale; one rebuild follows the batch. */
  private indexing = false;

  constructor(private readonly d: GraphServiceDeps) {
    this.log = d.log ?? (() => {});
    this.off = d.browse.onChange(() => this.invalidate());
  }

  /** The graph, built now when something changed since the last build. */
  data(): GraphData {
    if (this.dirty || !this.graph) this.rebuild();
    return this.graph!;
  }

  /**
   * The library started or finished indexing a batch of files. Rebuilding after every file costs a
   * full build each time (docs/app.md, Indexing time); the pages get one rebuild when it ends. A page
   * that asks meanwhile (data()) still gets a current graph.
   */
  setIndexing(on: boolean): void {
    if (on === this.indexing) return;
    this.indexing = on;
    if (on) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    } else if (this.dirty) this.invalidate();
  }

  /** Marks the graph stale and schedules a rebuild that tells the pages. */
  invalidate(): void {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.indexing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        const g = this.data();
        this.d.onChange?.(g);
      } catch (e) {
        this.log(`rebuild failed: ${(e as Error).message}`);
      }
    }, this.d.debounceMs ?? 400);
    this.timer.unref?.();
  }

  stop(): void {
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private rebuild(): void {
    const docs = this.d.browse.allDocuments();
    this.graph = buildGraph(docs, this.d.options());
    this.dirty = false;
    this.log(
      `built ${this.graph.nodes.length} nodes, ${this.graph.edges.length} edges, ${this.graph.families.length} families ` +
        `(${this.graph.profile.id}) in ${this.graph.buildMs} ms`,
    );
    try {
      fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
      const tmp = `${this.d.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.graph));
      fs.renameSync(tmp, this.d.file);
    } catch (e) {
      this.log(`not stored: ${(e as Error).message}`);
    }
  }
}
