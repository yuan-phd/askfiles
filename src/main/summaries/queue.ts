/**
 * The summary queue (docs/summaries.md, Queue): one job at a time, lowest priority. It is paused
 * while any gate is closed (the library is indexing, a question is being answered, the user paused
 * it, or summaries are off on this tier) and starts again only after the gates have been open for
 * idleMs. A gate that closes while a job runs aborts it; the job goes back to the front.
 */

export type SummaryJob =
  | { docId: string; level: 'document' }
  | { docId: string; level: 'section'; sectionIndex: number; origin: 'document' | 'library' };

export type Gate = 'off' | 'user' | 'indexing' | 'answering';
/** The order a reason is shown in when several gates are closed. */
const GATE_ORDER: Gate[] = ['off', 'user', 'indexing', 'answering'];

export interface QueueStatus {
  /** idle: nothing to do; waiting: the idle seconds before the next job; paused: a gate is closed. */
  state: 'idle' | 'waiting' | 'running' | 'paused';
  reason: Gate | null;
  /** Jobs finished in this batch and the batch size; a batch ends when the queue empties. */
  done: number;
  total: number;
  current: SummaryJob | null;
}

export interface QueueDeps {
  run(job: SummaryJob, signal: AbortSignal): Promise<void>;
  onStatus?(s: QueueStatus): void;
  /** Seconds the gates must stay open before work starts again. */
  idleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (msg: string) => void;
}

/** Five seconds: a follow-up question usually comes sooner, and then the queue keeps waiting. */
export const IDLE_MS = 5000;

export function jobKey(j: SummaryJob): string {
  return j.level === 'document' ? `${j.docId}:doc` : `${j.docId}:${j.sectionIndex}`;
}

/** Document summaries first, then the sections a user asked for on a page, then the library switch's. */
function rank(j: SummaryJob): number {
  if (j.level === 'document') return 0;
  return j.origin === 'document' ? 1 : 2;
}

export class SummaryQueue {
  private readonly jobs = new Map<string, { job: SummaryJob; seq: number }>();
  private seq = 0;
  private readonly closed = new Set<Gate>();
  private running: { job: SummaryJob; controller: AbortController } | null = null;
  private timer: unknown = null;
  private waiting = false;
  private done = 0;
  private readonly idleMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: QueueDeps) {
    this.idleMs = d.idleMs ?? IDLE_MS;
    this.setTimer =
      d.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  add(job: SummaryJob): void {
    const key = jobKey(job);
    if (this.jobs.has(key) || (this.running && jobKey(this.running.job) === key)) return;
    this.jobs.set(key, { job, seq: this.seq++ });
    this.kick();
  }

  has(job: SummaryJob): boolean {
    return this.jobs.has(jobKey(job)) || (!!this.running && jobKey(this.running.job) === jobKey(job));
  }

  /** Drops a document's queued jobs and aborts its running one (file removed or changed again). */
  removeDocument(docId: string): void {
    for (const [k, v] of this.jobs) if (v.job.docId === docId) this.jobs.delete(k);
    if (this.running?.job.docId === docId) {
      this.running.controller.abort();
    }
    this.emit();
  }

  /** Every queued job (not the running one), in the order they will run. */
  queued(): SummaryJob[] {
    return [...this.jobs.values()].sort((a, b) => rank(a.job) - rank(b.job) || a.seq - b.seq).map((x) => x.job);
  }

  clear(): void {
    this.jobs.clear();
    this.running?.controller.abort();
    this.emit();
  }

  setGate(gate: Gate, closed: boolean): void {
    if (closed === this.closed.has(gate)) return;
    if (closed) {
      this.closed.add(gate);
      this.cancelWait();
      if (this.running) {
        // Requeued at the front by its seq; the run's own rejection is ignored.
        const { job } = this.running;
        this.jobs.set(jobKey(job), { job, seq: -1 - this.seq++ });
        this.running.controller.abort();
        this.running = null;
      }
      this.emit();
    } else {
      this.closed.delete(gate);
      this.kick();
    }
  }

  pause(): void {
    this.setGate('user', true);
  }

  resume(): void {
    this.setGate('user', false);
  }

  status(): QueueStatus {
    const reason = GATE_ORDER.find((g) => this.closed.has(g)) ?? null;
    const left = this.jobs.size + (this.running ? 1 : 0);
    const state: QueueStatus['state'] = this.running ? 'running' : left === 0 ? 'idle' : reason ? 'paused' : 'waiting';
    return { state, reason, done: this.done, total: this.done + left, current: this.running?.job ?? null };
  }

  private emit(): void {
    if (!this.running && this.jobs.size === 0) this.done = 0;
    this.d.onStatus?.(this.status());
  }

  private cancelWait(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.waiting = false;
  }

  /** Starts the idle wait when there is work, no gate is closed and nothing runs. */
  private kick(): void {
    if (this.running || this.closed.size || !this.jobs.size || this.waiting) {
      this.emit();
      return;
    }
    this.waiting = true;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.waiting = false;
      this.next();
    }, this.idleMs);
    this.emit();
  }

  private next(): void {
    if (this.running || this.closed.size) return this.emit();
    const [first] = this.queued();
    if (!first) return this.emit();
    this.jobs.delete(jobKey(first));
    const controller = new AbortController();
    const mine = { job: first, controller };
    this.running = mine;
    this.emit();
    void this.d
      .run(first, controller.signal)
      .catch((e: Error) => {
        if (!controller.signal.aborted) this.d.log?.(`job ${jobKey(first)} failed: ${e.message}`);
      })
      .finally(() => {
        if (this.running !== mine) return;
        this.running = null;
        if (!controller.signal.aborted) this.done++;
        // Between jobs no idle wait: the gates are still open.
        if (!this.closed.size && this.jobs.size) this.setTimer(() => this.next(), 0);
        this.emit();
      });
  }
}
