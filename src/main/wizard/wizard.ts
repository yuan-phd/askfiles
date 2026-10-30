import { EventEmitter } from 'node:events';
import { normalizeTag, OllamaClient, type FetchLike, type PullProgress } from '../ollama/client.js';
import {
  chooseTier,
  detectRamBytes,
  presetEnv,
  presetHeader,
  workspaceSettings,
  writeServerEnv,
  type PresetFile,
  type TierChoice,
} from '../presets/index.js';
import { markUpstreamOnboarded } from './upstream.js';

export const STEPS = ['detectRam', 'chooseTier', 'pullModels', 'writeConfig', 'markOnboarded'] as const;
export type StepName = (typeof STEPS)[number];
export type WizardState = 'idle' | StepName | 'done' | 'error' | 'retry';

export interface WizardDeps {
  presets: PresetFile;
  /** Ollama must already be running (the process manager starts it). */
  ollama: OllamaClient;
  /** <dataDir>/server/.env */
  envFile: string;
  /**
   * Restart the server so it reads the new .env and resolve with its base URL once /api/ping
   * answers. With the Session C manager: stop() then start(), since start() reads the file.
   */
  restartServer(): Promise<string>;
  /** Writes the library workspace settings through the API; optional until the library exists. */
  applyWorkspaceSettings?(settings: Record<string, string | number>): Promise<void>;
  /**
   * Fetches the preset's reranker (src/main/answer, ensureReranker) after the Ollama models, with
   * the same progress events; skipped when absent, as in tests that only cover Ollama.
   */
  fetchReranker?(repo: string, onProgress: (p: PullProgress) => void): Promise<void>;
  /** Pretend total RAM in bytes; default os.totalmem(). */
  totalMemBytes?: number;
  fetch?: FetchLike;
  /** Injected into a .env created from nothing, for byte-exact tests. */
  secret?: () => string;
  log?: (message: string) => void;
}

export type WizardEvent =
  | { type: 'state'; state: WizardState; failedStep: StepName | null; error: string | null; attempt: number }
  | {
      type: 'tier';
      ramGb: number;
      tierId: string;
      label: string;
      belowMinimum: boolean;
      chatModel: string;
      embeddingModel: string;
    }
  | ({ type: 'progress'; index: number; count: number } & PullProgress);

export interface WizardSnapshot {
  state: WizardState;
  failedStep: StepName | null;
  error: string | null;
  attempt: number;
  ramBytes: number | null;
  tier: TierChoice | null;
}

/**
 * First-run wizard as a state machine:
 *
 *   idle -> detectRam -> chooseTier -> pullModels -> writeConfig -> markOnboarded -> done
 *   any step --throws--> error --retry()--> retry -> the step that failed
 *
 * Results of finished steps are kept, so a retry after a failed pull does not detect RAM again, and
 * models that finished pulling are found in /api/tags and skipped.
 */
export class Wizard extends EventEmitter<{ event: [WizardEvent] }> {
  private s: WizardSnapshot = { state: 'idle', failedStep: null, error: null, attempt: 1, ramBytes: null, tier: null };
  private running: Promise<WizardSnapshot> | null = null;

  constructor(private readonly deps: WizardDeps) {
    super();
  }

  snapshot(): WizardSnapshot {
    return { ...this.s };
  }

  /** Starts from idle. Never rejects: a failure ends in the error state, read it from the snapshot. */
  start(): Promise<WizardSnapshot> {
    if (this.running) return this.running;
    if (this.s.state !== 'idle') throw new Error(`start() needs state idle, not ${this.s.state}`);
    return this.launch(STEPS[0]);
  }

  /** Resumes at the step that failed. Only valid in the error state. */
  retry(): Promise<WizardSnapshot> {
    if (this.running) return this.running;
    if (this.s.state !== 'error' || this.s.failedStep === null) {
      throw new Error(`retry() needs state error, not ${this.s.state}`);
    }
    const from = this.s.failedStep;
    this.s.attempt += 1;
    this.setState('retry');
    return this.launch(from);
  }

  private launch(from: StepName): Promise<WizardSnapshot> {
    this.running = this.run(from).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(from: StepName): Promise<WizardSnapshot> {
    for (const step of STEPS.slice(STEPS.indexOf(from))) {
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
    this.setState('done');
    return this.snapshot();
  }

  private async step(step: StepName): Promise<void> {
    const d = this.deps;
    switch (step) {
      case 'detectRam':
        this.s.ramBytes = detectRamBytes(d.totalMemBytes);
        return;
      case 'chooseTier': {
        const tier = chooseTier(d.presets, this.s.ramBytes!);
        this.s.tier = tier;
        const p = tier.preset;
        this.log(`tier ${p.id} for ${tier.ramGb.toFixed(1)} GiB${tier.belowMinimum ? ' (below the lowest tier)' : ''}`);
        this.emit('event', {
          type: 'tier',
          ramGb: tier.ramGb,
          tierId: p.id,
          label: p.label,
          belowMinimum: tier.belowMinimum,
          chatModel: p.chatModel,
          embeddingModel: p.embeddingModel,
        });
        return;
      }
      case 'pullModels':
        return this.pullModels();
      case 'writeConfig': {
        const p = this.s.tier!.preset;
        writeServerEnv(d.envFile, presetEnv(p, { ollamaBaseUrl: d.ollama.baseUrl }), {
          header: presetHeader(p),
          secret: d.secret,
        });
        this.log(`wrote preset ${p.id} to ${d.envFile}`);
        return;
      }
      case 'markOnboarded': {
        const baseUrl = await d.restartServer();
        await markUpstreamOnboarded(baseUrl, d.fetch);
        await d.applyWorkspaceSettings?.(workspaceSettings(this.s.tier!.preset));
        return;
      }
    }
  }

  private async pullModels(): Promise<void> {
    const p = this.s.tier!.preset;
    // Embedder first: it is the smaller download and indexing needs it before any question.
    const tags = [...new Set([p.embeddingModel, p.chatModel])];
    const fetchReranker = this.deps.fetchReranker;
    const count = tags.length + (fetchReranker ? 1 : 0);
    const installed = await this.deps.ollama.list();
    for (const [index, tag] of tags.entries()) {
      const base = { type: 'progress' as const, index, count };
      const have = installed.find((m) => normalizeTag(m.name) === normalizeTag(tag));
      if (have) {
        this.log(`${tag} already installed`);
        this.emit('event', {
          ...base,
          model: tag,
          status: 'already installed',
          completedBytes: have.sizeBytes,
          totalBytes: have.sizeBytes,
          percent: 100,
        });
        continue;
      }
      this.log(`pulling ${tag}`);
      await this.deps.ollama.pull(tag, (pr) => this.emit('event', { ...base, ...pr }));
      this.log(`pulled ${tag}`);
    }
    if (fetchReranker) {
      const repo = p.answer.rerankerModel;
      this.log(`fetching reranker ${repo}`);
      await fetchReranker(repo, (pr) => this.emit('event', { type: 'progress', index: tags.length, count, ...pr }));
      this.log(`reranker ${repo} ready`);
    }
  }

  private setState(state: WizardState): void {
    this.s.state = state;
    const { failedStep, error, attempt } = this.s;
    this.emit('event', { type: 'state', state, failedStep, error, attempt });
  }

  private log(message: string): void {
    this.deps.log?.(`[wizard] ${message}`);
  }
}
