import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FirstRun, type FirstRunDeps, type SetupEvent, type WizardLike } from './first-run.js';
import { chooseTier, loadPresets } from './presets/index.js';
import { emptyShellState, type ShellState } from './shell-state.js';
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

function setup(over: Partial<FirstRunDeps> & { stored?: Partial<ShellState> } = {}) {
  const wizard = new FakeWizard();
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
    setupLibrary: async ({ preset, storedKey }) => {
      libraryCalls.push({ preset: preset.id, storedKey });
      if (failLibrary) throw new Error(failLibrary);
      return { apiKey: 'key-1', workspaceSlug: 'askfiles-library' };
    },
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
    events,
    setupStates,
    saves,
    libraryCalls,
    state: () => state,
    failLibrary: (m: string | null) => (failLibrary = m),
  };
}

describe('FirstRun', () => {
  it('runs models, sets up the default library, then marks setup complete without asking for a folder', async () => {
    const t = setup();
    expect(await t.run.start()).toMatchObject({ state: 'done', error: null });
    expect(t.setupStates()).toEqual(['models', 'createLibrary', 'done']);
    expect(t.libraryCalls).toEqual([{ preset: '16gb', storedKey: null }]);
    expect(t.state()).toMatchObject({ apiKey: 'key-1', setupCompletedAt: '2026-10-29T10:00:00.000Z' });
    expect(t.state().libraries.map((l) => [l.id, l.workspaceSlug, l.folders.length])).toEqual([
      ['all-files', 'askfiles-library', 0],
    ]);
    // The key and workspace are saved before the completed-setup marker.
    expect(t.saves[0]!.setupCompletedAt).toBeNull();
    expect(t.saves[0]!.libraries[0]!.workspaceSlug).toBe('askfiles-library');
    // Wizard events reach the page through the same stream.
    expect(t.events.some((e) => e.type === 'state' && e.state === 'done')).toBe(true);
  });

  it('ends in error when the wizard fails and retries through the wizard', async () => {
    const t = setup();
    t.wizard.fail = 'pull qwen3:8b failed: offline';
    expect(await t.run.start()).toMatchObject({
      state: 'error',
      failedStep: 'models',
      error: 'pull qwen3:8b failed: offline',
    });
    t.wizard.fail = null;
    expect(await t.run.retry()).toMatchObject({ state: 'done' });
    expect(t.wizard.calls).toEqual(['start', 'retry']);
  });

  it('retries a failed library step without running the wizard again, reusing the stored key', async () => {
    const t = setup({ stored: { apiKey: 'old-key' } });
    t.failLibrary('POST /v1/workspace/new failed (500): boom');
    expect(await t.run.start()).toMatchObject({ state: 'error', failedStep: 'createLibrary' });
    t.failLibrary(null);
    expect(await t.run.retry()).toMatchObject({ state: 'done' });
    expect(t.wizard.calls).toEqual(['start']);
    expect(t.libraryCalls.map((c) => c.storedKey)).toEqual(['old-key', 'old-key']);
  });

  it('joins a run in progress, rejects retry outside error, and replays state for a late page', async () => {
    const t = setup();
    expect(() => t.run.retry()).toThrow(/retry\(\) needs state error, not idle/);
    const first = t.run.start();
    expect(t.run.start()).toBe(first);
    await first;
    const replay = t.run.replay();
    expect(replay.map((e) => e.type)).toEqual(['state', 'setup']);
    expect(replay.at(-1)).toMatchObject({ type: 'setup', state: 'done' });
    expect(await t.run.start()).toMatchObject({ state: 'done' });
  });
});
