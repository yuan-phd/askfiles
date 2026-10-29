import { EventEmitter } from 'node:events';
import type { Preset } from './presets/index.js';
import type { ShellState } from './shell-state.js';
import type { WatcherStatus } from './watcher/index.js';
import type { WizardEvent, WizardSnapshot } from './wizard/index.js';

export const SETUP_STEPS = ['models', 'chooseFolder', 'createLibrary', 'indexing'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupState = 'idle' | SetupStep | 'done' | 'error';

/** The parts of the Session E wizard the first run drives. */
export interface WizardLike {
  start(): Promise<WizardSnapshot>;
  retry(): Promise<WizardSnapshot>;
  snapshot(): WizardSnapshot;
  on(event: 'event', listener: (e: WizardEvent) => void): unknown;
}

/** The parts of FolderWatcher the first run waits on. */
export interface WatcherLike {
  status(): WatcherStatus;
  whenIdle(): Promise<void>;
  on(event: 'status', listener: (s: WatcherStatus) => void): unknown;
}

export interface FirstRunDeps {
  wizard: WizardLike;
  loadState(): ShellState;
  saveState(state: ShellState): void;
  /** ASKFILES_LIBRARY_FOLDER: a folder chosen ahead, used instead of the dialog (smoke test). */
  presetFolder?: string | null;
  isDirectory(p: string): boolean;
  /** API key (the stored one if still valid) and the library workspace with the preset settings. */
  setupLibrary(o: { preset: Preset; storedKey: string | null }): Promise<{ apiKey: string; workspaceSlug: string }>;
  /** Starts the folder watcher; resolves once it has queued the folder's files. */
  startWatcher(o: { folder: string; workspaceSlug: string; apiKey: string; preset: Preset }): Promise<WatcherLike>;
  now?: () => Date;
  log?: (message: string) => void;
}

export type SetupEvent =
  | { type: 'setup'; state: SetupState; failedStep: SetupStep | null; error: string | null; folder: string | null }
  | { type: 'indexing'; status: WatcherStatus }
  | WizardEvent;

export interface SetupSnapshot {
  state: SetupState;
  failedStep: SetupStep | null;
  error: string | null;
  folder: string | null;
}

/**
 * The whole first run as a state machine around the wizard:
 *
 *   idle -> models (the wizard) -> chooseFolder -> createLibrary -> indexing -> done
 *   any step --throws--> error --retry()--> the step that failed
 *
 * chooseFolder waits for setFolder() unless a folder is already stored or preset. done writes
 * setupCompletedAt into shell.json, the marker later launches check. Every step is safe to run
 * again, so a first run cut off by a quit simply starts over at the next launch.
 */
export class FirstRun extends EventEmitter<{ event: [SetupEvent] }> {
  private s: SetupSnapshot = { state: 'idle', failedStep: null, error: null, folder: null };
  private running: Promise<SetupSnapshot> | null = null;
  private folderWaiter: ((folder: string) => void) | null = null;
  private watcher: WatcherLike | null = null;
  private lastWizard: { tier?: WizardEvent; progress?: WizardEvent; state?: WizardEvent } = {};

  constructor(private readonly d: FirstRunDeps) {
    super();
    d.wizard.on('event', (e) => {
      if (e.type === 'tier') this.lastWizard.tier = e;
      else if (e.type === 'progress') this.lastWizard.progress = e;
      else this.lastWizard.state = e;
      this.emit('event', e);
    });
  }

  snapshot(): SetupSnapshot {
    return { ...this.s };
  }

  /** The events a page that subscribes late needs to show the current state. */
  replay(): SetupEvent[] {
    const out: SetupEvent[] = [];
    for (const e of [this.lastWizard.tier, this.lastWizard.state, this.lastWizard.progress]) if (e) out.push(e);
    out.push({ type: 'setup', ...this.s });
    if (this.watcher) out.push({ type: 'indexing', status: this.watcher.status() });
    return out;
  }

  /** Starts from idle, or joins the run in progress. Never rejects; a failure ends in error. */
  start(): Promise<SetupSnapshot> {
    if (this.running) return this.running;
    if (this.s.state !== 'idle') return Promise.resolve(this.snapshot());
    return this.launch(SETUP_STEPS[0]);
  }

  /** Resumes at the step that failed. Only valid in the error state. */
  retry(): Promise<SetupSnapshot> {
    if (this.running) return this.running;
    if (this.s.state !== 'error' || this.s.failedStep === null) {
      throw new Error(`retry() needs state error, not ${this.s.state}`);
    }
    return this.launch(this.s.failedStep);
  }

  /** The folder the user picked. Only valid while the run waits in chooseFolder. */
  setFolder(folder: string): SetupSnapshot {
    if (this.s.state !== 'chooseFolder' || !this.folderWaiter) {
      throw new Error(`setFolder() needs state chooseFolder, not ${this.s.state}`);
    }
    if (!this.d.isDirectory(folder)) throw new Error(`${folder} is not a folder`);
    const resolve = this.folderWaiter;
    this.folderWaiter = null;
    resolve(folder);
    return this.snapshot();
  }

  /** The watcher started by the indexing step, kept running after done. */
  startedWatcher(): WatcherLike | null {
    return this.watcher;
  }

  private launch(from: SetupStep): Promise<SetupSnapshot> {
    this.running = this.run(from).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(from: SetupStep): Promise<SetupSnapshot> {
    for (const step of SETUP_STEPS.slice(SETUP_STEPS.indexOf(from))) {
      this.s.failedStep = null;
      this.s.error = null;
      this.setState(step);
      try {
        await this.step(step);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.s.failedStep = step;
        this.s.error = message;
        this.log(`${step} failed: ${message}`);
        this.setState('error');
        return this.snapshot();
      }
    }
    const state = this.d.loadState();
    this.d.saveState({ ...state, setupCompletedAt: (this.d.now?.() ?? new Date()).toISOString() });
    this.log('setup complete');
    this.setState('done');
    return this.snapshot();
  }

  private async step(step: SetupStep): Promise<void> {
    const d = this.d;
    switch (step) {
      case 'models': {
        const w = d.wizard.snapshot();
        if (w.state === 'done') return;
        const snap = w.state === 'error' ? await d.wizard.retry() : await d.wizard.start();
        if (snap.state !== 'done') throw new Error(snap.error ?? `the model setup ended in ${snap.state}`);
        return;
      }
      case 'chooseFolder': {
        const stored = d.loadState().folder;
        const preset = d.presetFolder ?? null;
        let folder: string;
        if (stored && d.isDirectory(stored)) folder = stored;
        else if (preset && d.isDirectory(preset)) folder = preset;
        else folder = await new Promise<string>((resolve) => (this.folderWaiter = resolve));
        this.s.folder = folder;
        d.saveState({ ...d.loadState(), folder });
        this.log(`library folder ${folder}`);
        // Tell the page which folder before the next step starts.
        this.setState('chooseFolder');
        return;
      }
      case 'createLibrary': {
        const state = d.loadState();
        const lib = await d.setupLibrary({ preset: this.preset(), storedKey: state.apiKey });
        d.saveState({ ...d.loadState(), apiKey: lib.apiKey, workspaceSlug: lib.workspaceSlug });
        this.log(`library workspace ${lib.workspaceSlug}`);
        return;
      }
      case 'indexing': {
        if (!this.watcher) {
          const state = d.loadState();
          if (!state.folder || !state.workspaceSlug || !state.apiKey) throw new Error('the library is not set up');
          const w = await d.startWatcher({
            folder: state.folder,
            workspaceSlug: state.workspaceSlug,
            apiKey: state.apiKey,
            preset: this.preset(),
          });
          w.on('status', (status) => this.emit('event', { type: 'indexing', status }));
          this.watcher = w;
        }
        this.emit('event', { type: 'indexing', status: this.watcher.status() });
        await this.watcher.whenIdle();
        return;
      }
    }
  }

  private preset(): Preset {
    const tier = this.d.wizard.snapshot().tier;
    if (!tier) throw new Error('no preset chosen yet');
    return tier.preset;
  }

  private setState(state: SetupState): void {
    this.s.state = state;
    this.emit('event', { type: 'setup', ...this.s });
  }

  private log(message: string): void {
    this.d.log?.(`[first-run] ${message}`);
  }
}
