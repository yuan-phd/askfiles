/**
 * One question at a time for the Ask page: runs the pipeline, streams its events tagged with the
 * run id, cancels a run when a new question comes, keeps the last trace for the developer panel.
 */
import { randomUUID } from 'node:crypto';
import { appendEvalCase, type EvalCase } from './eval-case.js';
import { answer, choose, retrieve, type AnswerEvent, type AnswerResult, type PipelineDeps } from './pipeline.js';
import type { RunSettings } from './params.js';
import { buildTrace, type Trace } from './trace.js';

export type ServiceEvent =
  | ({ id: string } & AnswerEvent)
  | { id: string; type: 'trace'; trace: Trace }
  | { id: string; type: 'error'; message: string };

/** Live controls of the developer panel; they replace the scope's values for the next question. */
export interface DeveloperOverrides {
  sectionCount?: number | null;
  rerankFloor?: number | null;
}

export interface ServiceDeps {
  /** Null while the library or the backend is not ready. */
  pipeline(): PipelineDeps | null;
  settings(): RunSettings;
  developer: boolean;
  /** Where Save as eval case appends. */
  evalQuestionsFile: string;
  log(msg: string): void;
}

export class AnswerService {
  private current: { id: string; controller: AbortController } | null = null;
  private overrides: DeveloperOverrides = {};
  private lastTrace: Trace | null = null;

  constructor(private readonly d: ServiceDeps) {}

  /** Starts a run and returns its id at once; events follow through emit. */
  ask(question: string, emit: (e: ServiceEvent) => void): { id: string } {
    this.current?.controller.abort();
    const id = randomUUID();
    const controller = new AbortController();
    this.current = { id, controller };
    void this.run(id, question, controller.signal, emit).finally(() => {
      if (this.current?.id === id) this.current = null;
    });
    return { id };
  }

  cancel(id: string): void {
    if (this.current?.id === id) {
      this.current.controller.abort();
      this.current = null;
    }
  }

  /** Runs one question to its result without streaming, for the smoke check. */
  async askOnce(question: string): Promise<AnswerResult> {
    let result: AnswerResult | null = null;
    let error: string | null = null;
    await this.run(randomUUID(), question, undefined, (e) => {
      if (e.type === 'done') result = e.result;
      if (e.type === 'error') error = e.message;
    });
    if (!result) throw new Error(error ?? 'no answer');
    return result;
  }

  developerState(): { enabled: boolean; overrides: DeveloperOverrides; trace: Trace | null } {
    if (!this.d.developer) return { enabled: false, overrides: {}, trace: null };
    return { enabled: true, overrides: { ...this.overrides }, trace: this.lastTrace };
  }

  setOverrides(o: DeveloperOverrides): DeveloperOverrides {
    if (!this.d.developer) throw new Error('developer mode is off');
    const count = o.sectionCount;
    const floor = o.rerankFloor;
    if (count !== undefined && count !== null && !(Number.isInteger(count) && count >= 1 && count <= 20)) {
      throw new Error('section count must be an integer from 1 to 20');
    }
    if (floor !== undefined && floor !== null && !(typeof floor === 'number' && floor >= 0 && floor <= 1)) {
      throw new Error('rerank floor must be a number from 0 to 1');
    }
    this.overrides = { sectionCount: count ?? null, rerankFloor: floor ?? null };
    this.d.log(`[answer] developer overrides ${JSON.stringify(this.overrides)}`);
    return { ...this.overrides };
  }

  saveEvalCase(c: EvalCase): { id: string; file: string } {
    if (!this.d.developer) throw new Error('developer mode is off');
    const id = appendEvalCase(this.d.evalQuestionsFile, c);
    this.d.log(`[answer] saved eval case ${id} to ${this.d.evalQuestionsFile}`);
    return { id, file: this.d.evalQuestionsFile };
  }

  /** The run settings with the developer overrides applied to the current scope. */
  effectiveSettings(): RunSettings {
    const s = this.d.settings();
    if (!this.d.developer) return s;
    const params = structuredClone(s.params);
    if (typeof this.overrides.sectionCount === 'number') params.sectionCount[s.scope] = this.overrides.sectionCount;
    if (typeof this.overrides.rerankFloor === 'number') params.rerankFloor[s.scope] = this.overrides.rerankFloor;
    return { ...s, params };
  }

  private async run(
    id: string,
    question: string,
    signal: AbortSignal | undefined,
    emit: (e: ServiceEvent) => void,
  ): Promise<void> {
    const send = (e: AnswerEvent | { type: 'trace'; trace: Trace } | { type: 'error'; message: string }) => {
      if (!signal?.aborted) emit({ id, ...e } as ServiceEvent);
    };
    const t0 = performance.now();
    try {
      const deps = this.d.pipeline();
      if (!deps) throw new Error('The library is not ready yet. Try again in a moment.');
      const s = this.effectiveSettings();
      send({ type: 'stage', stage: 'retrieving' });
      const r = await retrieve(question, s, deps, signal);
      const sel = choose(r, s);
      const trace = buildTrace(r, sel, {
        scope: s.scope,
        floor: s.params.rerankFloor[s.scope],
        count: s.params.sectionCount[s.scope],
      });
      this.lastTrace = trace;
      if (this.d.developer) send({ type: 'trace', trace });
      const result = await answer(question, r, sel, s, deps, send, signal);
      trace.timings.firstTokenMs = result.timings.firstTokenMs;
      trace.timings.modelMs = result.timings.modelMs;
      this.d.log(
        `[answer] ${result.notFound ? 'not found' : `${result.cited.length} cited`} of ${sel.selected.length} selected, ` +
          `${r.candidates.length} candidates${r.bypass ? ` (rerank bypassed: ${r.bypassReason})` : ''}, ` +
          `vector ${r.timings.vectorMs} ms, keyword ${r.timings.keywordMs} ms, rerank ${r.timings.rerankMs} ms, ` +
          `first token ${result.timings.firstTokenMs ?? '-'} ms, total ${Math.round(performance.now() - t0)} ms`,
      );
    } catch (e) {
      if (signal?.aborted) return;
      const message = (e as Error).message;
      this.d.log(`[answer] failed: ${message}`);
      send({ type: 'error', message });
    }
  }
}
