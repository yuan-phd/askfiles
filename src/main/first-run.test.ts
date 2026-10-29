import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FirstRun, type FirstRunDeps, type SetupEvent, type WatcherLike, type WizardLike } from './first-run.js';
import { chooseTier, loadPresets } from './presets/index.js';
import { emptyShellState, type ShellState } from './shell-state.js';
import type { WatcherStatus } from './watcher/index.js';
import type { WizardEvent, WizardSnapshot } from './wizard/index.js';

const presets = loadPresets(path.resolve(import.meta.dirname, '../../config/presets.json'));
const tier = chooseTier(presets, 16 * 1024 ** 3);

/** A wizard that ends done, or in error while fail is set. */
class FakeWizard extends EventEmitter<{ event: [WizardEvent] }> implements WizardLike {
  fail: string | null = null;
  calls: string[] = [];
  private s: WizardSnapshot = { state: 'idle', failedStep: null, error: null, attempt: 1, ramBytes: null, tier: null };
  snapshot() {
    return { ...this.s };
  }
  private async finish(): Promise<WizardSnapshot> {
    this.s.tier = tier;
    this.emit('event', { type: 'state', state: 'pullModels', failedStep: null, error: null, attempt: this.s.attempt });
    if (this.fail) {
      this.s = { ...this.s, state: 'error', failedStep: 'pullModels', error: this.fail };
    } else {
      this.s = { ...this.s, state: 'done', failedStep: null, error: null };
    }
    this.emit('event', {
      type: 'state',
      state: this.s.state,
      failedStep: this.s.failedStep,
      error: this.s.error,
      attempt: 1,
    });
    return this.snapshot();
  }
  async start() {
    this.calls.push('start');
    return this.finish();
  }
  async retry() {
    this.calls.push('retry');
    this.s.attempt += 1;
    return this.finish();
  }
}

class FakeWatcher extends EventEmitter<{ status: [WatcherStatus] }> implements WatcherLike {
  idle: () => void = () => {};
  private st: WatcherStatus = { state: 'working', pending: 2, current: null, indexed: 0, deadLetters: [] };
  status() {
    return { ...this.st };
  }
  whenIdle() {
    return new Promise<void>((resolve) => (this.idle = resolve));
  }
  finish() {
    this.st = { state: 'idle', pending: 0, current: null, indexed: 2, deadLetters: [] };
    this.emit('status', this.status());
    this.idle();
  }
}

function setup(over: Partial<FirstRunDeps> & { dirs?: string[]; stored?: Partial<ShellState> } = {}) {
  const wizard = new FakeWizard();
  const watcher = new FakeWatcher();
  let state: ShellState = { ...emptyShellState(), ...over.stored };
  const saves: ShellState[] = [];
  const libraryCalls: { preset: string; storedKey: string | null }[] = [];
  let failLibrary: string | null = null;
  const deps: FirstRunDeps = {
    wizard,
    loadState: () => ({ ...state }),
    saveState: (s) => {
      state = { ...s };
      saves.push({ ...s });
    },
    isDirectory: (p) => (over.dirs ?? ['/Users/u/Documents']).includes(p),
    setupLibrary: async ({ preset, storedKey }) => {
      libraryCalls.push({ preset: preset.id, storedKey });
      if (failLibrary) throw new Error(failLibrary);
      return { apiKey: 'key-1', workspaceSlug: 'askfiles-library' };
    },
    startWatcher: async () => watcher,
    now: () => new Date('2026-10-29T10:00:00Z'),
    ...over,
  };
  const run = new FirstRun(deps);
  const events: SetupEvent[] = [];
  run.on('event', (e) => events.push(e));
  const setupStates = () => events.filter((e) => e.type === 'setup').map((e) => (e as { state: string }).state);
  return {
    run,
    wizard,
    watcher,
    events,
    setupStates,
    saves,
    libraryCalls,
    state: () => state,
    failLibrary: (m: string | null) => (failLibrary = m),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('FirstRun', () => {
  it('runs models, waits for the folder, sets up the library, indexes, then marks setup complete', async () => {
    const t = setup();
    const done = t.run.start();
    await tick();
    expect(t.run.snapshot().state).toBe('chooseFolder');
    expect(t.state().setupCompletedAt).toBeNull();

    t.run.setFolder('/Users/u/Documents');
    await tick();
    expect(t.run.snapshot()).toMatchObject({ state: 'indexing', folder: '/Users/u/Documents' });
    expect(t.libraryCalls).toEqual([{ preset: '16gb', storedKey: null }]);
    expect(t.state()).toMatchObject({
      folder: '/Users/u/Documents',
      apiKey: 'key-1',
      workspaceSlug: 'askfiles-library',
    });
    expect(t.state().setupCompletedAt).toBeNull();

    t.watcher.finish();
    expect(await done).toMatchObject({ state: 'done', error: null });
    expect(t.setupStates()).toEqual(['models', 'chooseFolder', 'chooseFolder', 'createLibrary', 'indexing', 'done']);
    expect(t.state().setupCompletedAt).toBe('2026-10-29T10:00:00.000Z');
    // Wizard events reach the page through the same stream.
    expect(t.events.some((e) => e.type === 'state' && e.state === 'done')).toBe(true);
    expect(
      t.events.filter((e) => e.type === 'indexing').map((e) => (e as { status: WatcherStatus }).status.state),
    ).toEqual(['working', 'idle']);
  });

  it('skips the dialog for a stored folder that still exists, and for a preset folder', async () => {
    const stored = setup({ stored: { folder: '/Users/u/Documents' } });
    const p1 = stored.run.start();
    await tick();
    stored.watcher.finish();
    expect(await p1).toMatchObject({ state: 'done', folder: '/Users/u/Documents' });

    const preset = setup({ stored: { folder: '/gone' }, presetFolder: '/tmp/smoke', dirs: ['/tmp/smoke'] });
    const p2 = preset.run.start();
    await tick();
    preset.watcher.finish();
    expect(await p2).toMatchObject({ state: 'done', folder: '/tmp/smoke' });
    expect(preset.state().folder).toBe('/tmp/smoke');
  });

  it('refuses a folder that is not a directory and keeps waiting', async () => {
    const t = setup();
    void t.run.start();
    await tick();
    expect(() => t.run.setFolder('/nope')).toThrow('/nope is not a folder');
    expect(t.run.snapshot().state).toBe('chooseFolder');
    expect(() => setup().run.setFolder('/Users/u/Documents')).toThrow(/needs state chooseFolder, not idle/);
  });

  it('ends in error when the wizard fails and retries through the wizard', async () => {
    const t = setup({ stored: { folder: '/Users/u/Documents' } });
    t.wizard.fail = 'pull qwen3:8b failed: offline';
    expect(await t.run.start()).toMatchObject({
      state: 'error',
      failedStep: 'models',
      error: 'pull qwen3:8b failed: offline',
    });
    expect(() => t.run.setFolder('/Users/u/Documents')).toThrow();

    t.wizard.fail = null;
    const again = t.run.retry();
    await tick();
    t.watcher.finish();
    expect(await again).toMatchObject({ state: 'done' });
    expect(t.wizard.calls).toEqual(['start', 'retry']);
  });

  it('retries a failed library step without running the wizard again, reusing the stored key', async () => {
    const t = setup({ stored: { folder: '/Users/u/Documents', apiKey: 'old-key' } });
    t.failLibrary('POST /v1/workspace/new failed (500): boom');
    expect(await t.run.start()).toMatchObject({ state: 'error', failedStep: 'createLibrary' });
    t.failLibrary(null);
    const again = t.run.retry();
    await tick();
    t.watcher.finish();
    expect(await again).toMatchObject({ state: 'done' });
    expect(t.wizard.calls).toEqual(['start']);
    expect(t.libraryCalls.map((c) => c.storedKey)).toEqual(['old-key', 'old-key']);
  });

  it('joins a run in progress, rejects retry outside error, and replays state for a late page', async () => {
    const t = setup();
    expect(() => t.run.retry()).toThrow(/retry\(\) needs state error, not idle/);
    const first = t.run.start();
    expect(t.run.start()).toBe(first);
    await tick();
    const replay = t.run.replay();
    expect(replay.map((e) => e.type)).toEqual(['state', 'setup']);
    expect(replay.at(-1)).toMatchObject({ type: 'setup', state: 'chooseFolder', folder: null });
    t.run.setFolder('/Users/u/Documents');
    await tick();
    expect(t.run.replay().at(-1)).toMatchObject({ type: 'indexing', status: { state: 'working', pending: 2 } });
    t.watcher.finish();
    await first;
    expect(await t.run.start()).toMatchObject({ state: 'done' });
  });
});
