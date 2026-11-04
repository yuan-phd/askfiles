import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SummaryQueue, type QueueStatus, type SummaryJob } from './queue.js';

/** A run that finishes when the test says so, or when aborted. */
function controlledRun() {
  const started: { job: SummaryJob; jobs: SummaryJob[]; signal: AbortSignal; finish: () => void }[] = [];
  const run = (jobs: SummaryJob[], signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      started.push({ job: jobs[0]!, jobs, signal, finish: resolve });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { run, started };
}

const doc = (docId: string): SummaryJob => ({ docId, level: 'document' });
const sec = (docId: string, i: number, origin: 'document' | 'library' = 'library'): SummaryJob => ({
  docId,
  level: 'section',
  sectionIndex: i,
  origin,
});

describe('summary queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits the idle seconds, then runs one job at a time, document summaries first', async () => {
    const c = controlledRun();
    const statuses: QueueStatus[] = [];
    const q = new SummaryQueue({ run: c.run, idleMs: 5000, onStatus: (s) => statuses.push(s) });
    q.add(sec('b', 1));
    q.add(sec('a', 2, 'document'));
    q.add(doc('c'));
    q.add(doc('c'));
    expect(q.status()).toMatchObject({ state: 'waiting', done: 0, total: 3 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(c.started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.started.map((s) => s.job)).toEqual([doc('c')]);
    expect(q.status()).toMatchObject({ state: 'running', done: 0, total: 3 });
    c.started[0]!.finish();
    await vi.advanceTimersByTimeAsync(1);
    // No idle wait between jobs; a section asked for on its page before the library's.
    expect(c.started.map((s) => s.job)).toEqual([doc('c'), sec('a', 2, 'document')]);
    expect(q.status()).toMatchObject({ done: 1, total: 3 });
    c.started[1]!.finish();
    await vi.advanceTimersByTimeAsync(1);
    c.started[2]!.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(q.status()).toMatchObject({ state: 'idle', done: 0, total: 0 });
    expect(statuses.some((s) => s.done === 2 && s.total === 3)).toBe(true);
  });

  it('pauses while indexing or answering, aborts the running job and runs it again first', async () => {
    const c = controlledRun();
    const q = new SummaryQueue({ run: c.run, idleMs: 3000 });
    q.add(doc('a'));
    q.add(doc('b'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.started).toHaveLength(1);
    q.setGate('answering', true);
    expect(c.started[0]!.signal.aborted).toBe(true);
    expect(q.status()).toMatchObject({ state: 'paused', reason: 'answering', total: 2 });
    q.setGate('indexing', true);
    q.setGate('answering', false);
    expect(q.status()).toMatchObject({ state: 'paused', reason: 'indexing' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.started).toHaveLength(1);
    q.setGate('indexing', false);
    await vi.advanceTimersByTimeAsync(2999);
    expect(c.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.started.map((s) => s.job.docId)).toEqual(['a', 'a']);
  });

  it('a gate that closes again during the idle wait restarts the wait', async () => {
    const c = controlledRun();
    const q = new SummaryQueue({ run: c.run, idleMs: 5000 });
    q.add(doc('a'));
    await vi.advanceTimersByTimeAsync(4000);
    q.setGate('answering', true);
    q.setGate('answering', false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(c.started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.started).toHaveLength(1);
  });

  it('the user pause holds until resumed; off holds on a tier without summaries', async () => {
    const c = controlledRun();
    const q = new SummaryQueue({ run: c.run, idleMs: 10 });
    q.pause();
    q.add(doc('a'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(q.status()).toMatchObject({ state: 'paused', reason: 'user' });
    q.setGate('off', true);
    expect(q.status().reason).toBe('off');
    q.setGate('off', false);
    q.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(c.started).toHaveLength(1);
  });

  it('drops a removed document and stops its running job without counting it', async () => {
    const c = controlledRun();
    const q = new SummaryQueue({ run: c.run, idleMs: 1 });
    q.add(doc('a'));
    q.add(sec('a', 1));
    q.add(doc('b'));
    await vi.advanceTimersByTimeAsync(1);
    q.removeDocument('a');
    expect(c.started[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(q.queued()).toEqual([]);
    expect(c.started.map((s) => s.job)).toEqual([doc('a'), doc('b')]);
    expect(q.status()).toMatchObject({ done: 0, total: 1 });
  });

  it('runs the jobs the batch hook picks in one run; they count, requeue and abort together', async () => {
    const c = controlledRun();
    const q = new SummaryQueue({
      run: c.run,
      idleMs: 1,
      batch: (first, queued) =>
        first.level === 'section'
          ? queued.filter((j) => j.docId === first.docId && j.level === 'section').slice(0, 2)
          : [],
    });
    q.add(doc('a'));
    for (const i of [1, 2, 3, 4]) q.add(sec('a', i));
    q.add(sec('b', 1));
    await vi.advanceTimersByTimeAsync(1);
    expect(c.started.map((r) => r.jobs.length)).toEqual([1]);
    c.started[0]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.started[1]!.jobs.map((j) => (j.level === 'section' ? j.sectionIndex : 0))).toEqual([1, 2, 3]);
    expect(q.status()).toMatchObject({ state: 'running', done: 1, total: 6 });
    expect(q.has(sec('a', 3))).toBe(true);
    // A pause puts the whole batch back at the front, in order.
    q.pause();
    expect(c.started[1]!.signal.aborted).toBe(true);
    expect(q.queued().map((j) => `${j.docId}${j.level === 'section' ? j.sectionIndex : 'd'}`)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'b1',
    ]);
    q.resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(c.started[2]!.jobs).toHaveLength(3);
    c.started[2]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(q.status()).toMatchObject({ done: 4, total: 6 });
    // The next run takes a4 alone: b1 is another document.
    expect(c.started[3]!.jobs).toHaveLength(1);
  });
});
