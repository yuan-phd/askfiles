/**
 * One question at a time for the Ask page: runs the pipeline, streams its events tagged with the
 * run id, cancels a run when a new question comes, keeps the last trace for the developer panel.
 */
import { randomUUID } from 'node:crypto';
import { answerSplit, describeSplit, splitQuestion } from './decompose.js';
import { appendEvalCase, type EvalCase } from './eval-case.js';
import {
  answer,
  choose,
  retrieve,
  type AnswerEvent,
  type AnswerResult,
  type PipelineDeps,
  type Retrieval,
} from './pipeline.js';
import type { Selection } from './select.js';
import { floorOf, setFloor, type RunSettings } from './params.js';
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
  /** True when a question starts, false when the last one ends; the summary queue pauses meanwhile. */
  onBusy?(busy: boolean): void;
  /**
   * Told about every question once it ends; only the test build passes one (src/main/test-build.ts).
   * It reads the run and changes nothing; an error it throws is logged and ignored.
   */
  onAnswered?(run: AnsweredRun): void;
}

/** A finished question as onAnswered sees it. */
export interface AnsweredRun {
  question: string;
  /** The retrieval of the question (of its first part when split); null when it failed before. */
  retrieval: Retrieval | null;
  result: AnswerResult | null;
  /** The message the page showed; null unless the run failed. */
  error: string | null;
  /** A newer question or the page cancelled this one before it ended. */
  cancelled: boolean;
  totalMs: number;
}

export class AnswerService {
  private current: { id: string; controller: AbortController } | null = null;
  private overrides: DeveloperOverrides = {};
  private lastTrace: Trace | null = null;
  private running = 0;

  constructor(private readonly d: ServiceDeps) {}

  /** True while a question is being answered. */
  busy(): boolean {
    return this.running > 0;
  }

  private async tracked<T>(work: Promise<T>): Promise<T> {
    if (this.running++ === 0) this.d.onBusy?.(true);
    try {
      return await work;
    } finally {
      if (--this.running === 0) this.d.onBusy?.(false);
    }
  }

  /** Starts a run and returns its id at once; events follow through emit. */
  ask(question: string, emit: (e: ServiceEvent) => void): { id: string } {
    this.current?.controller.abort();
    const id = randomUUID();
    const controller = new AbortController();
    this.current = { id, controller };
    void this.tracked(this.run(id, question, controller.signal, emit)).finally(() => {
      if (this.current?.id === id) this.current = null;
    });
    return { id };
  }

  /**
   * Cancels the question being answered, whatever its id (the current library changed). Its model
   * request is aborted and send() lets no further event of it through.
   */
  cancelCurrent(reason: string): boolean {
    if (!this.current) return false;
    this.d.log(`[answer] cancelled: ${reason}`);
    this.current.controller.abort();
    this.current = null;
    return true;
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
    await this.tracked(
      this.run(randomUUID(), question, undefined, (e) => {
        if (e.type === 'done') result = e.result;
        if (e.type === 'error') error = e.message;
      }),
    );
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
    // The panel's floor field sets whichever floor decides selection: vector without a reranker.
    if (typeof this.overrides.rerankFloor === 'number') setFloor(params, s.scope, this.overrides.rerankFloor);
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
    let first: { r: Retrieval; sel: Selection; trace: Trace } | null = null;
    const observe = (o: Pick<AnsweredRun, 'result' | 'error' | 'cancelled'>) => {
      if (!this.d.onAnswered) return;
      try {
        this.d.onAnswered({ question, retrieval: first?.r ?? null, totalMs: Math.round(performance.now() - t0), ...o });
      } catch (e) {
        this.d.log(`[answer] observer failed: ${(e as Error).message}`);
      }
    };
    try {
      const deps = this.d.pipeline();
      if (!deps) throw new Error('The library is not ready yet. Try again in a moment.');
      const s = this.effectiveSettings();
      send({ type: 'stage', stage: 'retrieving' });
      send({ type: 'progress', progress: { stage: 'searching' } });
      // The trace and the log line describe the first part of a split question.
      const one = async (q: string, emit: (e: AnswerEvent) => void) => {
        const r = await retrieve(q, s, deps, signal, (progress) => emit({ type: 'progress', progress }));
        const sel = choose(r, s);
        if (!first) {
          const trace = buildTrace(r, sel, {
            scope: s.scope,
            floor: floorOf(s.params, s.scope),
            count: s.params.sectionCount[s.scope],
          });
          first = { r, sel, trace };
          this.lastTrace = trace;
          if (this.d.developer) send({ type: 'trace', trace });
        }
        return answer(q, r, sel, s, deps, emit, signal);
      };
      const split = s.params.decomposeQuestions ? splitQuestion(question) : null;
      if (split) this.d.log(`[answer] decompose: ${describeSplit(split)}`);
      const result = split
        ? await answerSplit(split, (part, emit) => one(part.text, emit), send)
        : await one(question, send);
      if (split) send({ type: 'done', result });
      const { r, sel, trace } = first!;
      trace.timings.firstTokenMs = result.timings.firstTokenMs;
      trace.timings.modelMs = result.timings.modelMs;
      this.d.log(
        `[answer] ${result.notFound ? 'not found' : `${result.cited.length} cited`} of ${sel.selected.length} selected, ` +
          `${r.candidates.length} candidates${r.bypass ? ` (rerank bypassed: ${r.bypassReason})` : ''}, ` +
          `vector ${r.timings.vectorMs} ms, keyword ${r.timings.keywordMs} ms, rerank ${r.timings.rerankMs} ms, ` +
          `first token ${result.timings.firstTokenMs ?? '-'} ms, total ${Math.round(performance.now() - t0)} ms`,
      );
      observe({ result, error: null, cancelled: !!signal?.aborted });
    } catch (e) {
      if (signal?.aborted) {
        observe({ result: null, error: null, cancelled: true });
        return;
      }
      const message = (e as Error).message;
      this.d.log(`[answer] failed: ${message}`);
      send({ type: 'error', message });
      observe({ result: null, error: message, cancelled: false });
    }
  }
}
