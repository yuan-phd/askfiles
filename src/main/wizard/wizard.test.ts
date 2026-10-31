import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { OllamaClient } from '../ollama/client.js';
import { startFakeOllama, type FakeOllama } from '../ollama/__fixtures__/fake-ollama.js';
import { loadPresets } from '../presets/index.js';
import { Wizard, type WizardDeps, type WizardEvent } from './wizard.js';

const presets = loadPresets(path.resolve(import.meta.dirname, '../../../config/presets.json'));
const GIB = 1024 ** 3;
const Q3 = 'hf.co/unsloth/Qwen3-14B-GGUF:Q3_K_M';
const PIN = presets.tiers.find((t) => t.id === '16gb')!.chatModelFile!;

let fakes: FakeOllama[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});

async function setup(over: Partial<WizardDeps> = {}, fakeOptions: Parameters<typeof startFakeOllama>[0] = {}) {
  // One fake serves both the Ollama routes and the upstream onboarding routes.
  // A pull of the 16 GB model installs the pinned weights unless a test says otherwise.
  const fake = await startFakeOllama({ onboarding: true, pullDigests: { [Q3]: PIN.sha256 }, ...fakeOptions });
  fakes.push(fake);
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-wizard-')), 'server', '.env');
  let restarts = 0;
  const applied: unknown[] = [];
  const deps: WizardDeps = {
    presets,
    ollama: new OllamaClient({ baseUrl: fake.url }),
    envFile,
    restartServer: async () => {
      restarts += 1;
      return fake.url;
    },
    applyWorkspaceSettings: async (s) => {
      applied.push(s);
    },
    totalMemBytes: 16 * GIB,
    ...over,
  };
  const wizard = new Wizard(deps);
  const events: WizardEvent[] = [];
  wizard.on('event', (e) => events.push(e));
  const states = () => events.filter((e) => e.type === 'state').map((e) => e.state);
  return { fake, wizard, events, states, envFile, applied, restarts: () => restarts };
}

/** The shipped presets with the 16 GB tier's reranker set, since the presets may turn it off. */
function withReranker(repo: string): typeof presets {
  const p = structuredClone(presets);
  p.tiers.find((t) => t.id === '16gb')!.answer.rerankerModel = repo;
  return p;
}

describe('Wizard', () => {
  it('fetches the tier reranker after the Ollama models, as the last download', async () => {
    const fetched: string[] = [];
    const t = await setup({
      presets: withReranker('Xenova/bge-reranker-base'),
      fetchReranker: async (repo, onProgress) => {
        fetched.push(repo);
        onProgress({ model: 'bge-reranker-v2-m3', status: 'success', completedBytes: 9, totalBytes: 9, percent: 100 });
      },
    });
    await t.wizard.start();
    expect(fetched).toEqual(['Xenova/bge-reranker-base']);
    const done = t.events.filter((e) => e.type === 'progress' && e.percent === 100);
    expect(done.map((e) => e.type === 'progress' && [e.model, e.index, e.count])).toEqual([
      ['bge-m3:567m', 0, 3],
      [Q3, 1, 3],
      ['bge-reranker-v2-m3', 2, 3],
    ]);
  });

  it('fetches no reranker when the tier has rerankerModel none', async () => {
    const fetched: string[] = [];
    const t = await setup({
      presets: withReranker('none'),
      fetchReranker: async (repo) => {
        fetched.push(repo);
      },
    });
    await t.wizard.start();
    expect(fetched).toEqual([]);
    const done = t.events.filter((e) => e.type === 'progress' && e.percent === 100);
    expect(done.map((e) => e.type === 'progress' && [e.model, e.index, e.count])).toEqual([
      ['bge-m3:567m', 0, 2],
      [Q3, 1, 2],
    ]);
  });

  it('runs every step in order and ends done', async () => {
    const t = await setup();
    const snap = await t.wizard.start();

    expect(t.states()).toEqual(['detectRam', 'chooseTier', 'pullModels', 'writeConfig', 'markOnboarded', 'done']);
    expect(snap).toMatchObject({ state: 'done', failedStep: null, error: null, attempt: 1, ramBytes: 16 * GIB });
    expect(snap.tier?.preset.id).toBe('16gb');
    expect(t.events.find((e) => e.type === 'tier')).toEqual({
      type: 'tier',
      ramGb: 16,
      tierId: '16gb',
      label: '16 GB',
      belowMinimum: false,
      chatModel: Q3,
      embeddingModel: 'bge-m3:567m',
    });
    expect(t.fake.pulls).toEqual(['bge-m3:567m', Q3]);
    const done = t.events.filter((e) => e.type === 'progress' && e.percent === 100);
    expect(done.map((e) => e.type === 'progress' && [e.model, e.index, e.count])).toEqual([
      ['bge-m3:567m', 0, 2],
      [Q3, 1, 2],
    ]);

    const env = util.parseEnv(fs.readFileSync(t.envFile, 'utf8'));
    expect(env).toMatchObject({
      OLLAMA_MODEL_PREF: Q3,
      OLLAMA_BASE_PATH: t.fake.url,
      DEFAULT_REASONING_EFFORT: 'off',
    });
    expect(env.JWT_SECRET).toBeTruthy();
    expect(t.restarts()).toBe(1);
    expect(t.fake.onboardingPosts).toBe(1);
    expect(t.applied).toEqual([expect.objectContaining({ chatMode: 'query', topN: 4 })]);
  });

  it('retries after a failed pull from the pull step, skipping the model already installed', async () => {
    const failPull = new Set([Q3]);
    const t = await setup({}, { failPull });
    const failed = await t.wizard.start();

    expect(failed).toMatchObject({ state: 'error', failedStep: 'pullModels', attempt: 1 });
    expect(failed.error).toMatch(/failed: connection reset by peer/);
    expect(t.states()).toEqual(['detectRam', 'chooseTier', 'pullModels', 'error']);
    expect(fs.existsSync(t.envFile)).toBe(false);

    failPull.clear();
    t.events.length = 0;
    const snap = await t.wizard.retry();
    expect(snap).toMatchObject({ state: 'done', attempt: 2, error: null });
    expect(t.states()).toEqual(['retry', 'pullModels', 'writeConfig', 'markOnboarded', 'done']);
    expect(t.fake.pulls).toEqual(['bge-m3:567m', Q3, Q3]);
    expect(t.events.find((e) => e.type === 'progress' && e.model === 'bge-m3:567m')).toMatchObject({
      status: 'already installed',
      percent: 100,
    });
  });

  it('retries a failed onboarding call without pulling again', async () => {
    let fail = true;
    const t = await setup({
      restartServer: async () => {
        if (fail) throw new Error('server did not answer /api/ping in 120 s');
        return t.fake.url;
      },
    });
    expect(await t.wizard.start()).toMatchObject({ state: 'error', failedStep: 'markOnboarded' });
    fail = false;
    expect(await t.wizard.retry()).toMatchObject({ state: 'done' });
    expect(t.fake.pulls).toEqual(['bge-m3:567m', Q3]);
  });

  it('flags a machine below the lowest tier and still gives it that tier', async () => {
    const t = await setup({ totalMemBytes: 7.9 * GIB });
    const snap = await t.wizard.start();
    expect(snap.tier).toMatchObject({ belowMinimum: true, preset: { id: '8gb' } });
    // Ask is off on 8 GB: only the embedder is pulled, and the .env names no chat model.
    expect(t.fake.pulls).toEqual(['bge-m3:567m']);
    expect(snap.state).toBe('done');
    expect(util.parseEnv(fs.readFileSync(t.envFile, 'utf8')).OLLAMA_MODEL_PREF).toBeUndefined();
  });

  it('refuses a pinned model whose weights are not the measured file, pulled or already installed', async () => {
    const other = 'f'.repeat(64);
    const t = await setup({}, { pullDigests: { [Q3]: other } });
    const snap = await t.wizard.start();
    expect(snap).toMatchObject({ state: 'error', failedStep: 'pullModels' });
    expect(snap.error).toContain(
      `expected Qwen3-14B-Q3_K_M.gguf from unsloth/Qwen3-14B-GGUF at revision ${PIN.revision}`,
    );
    expect(snap.error).toContain(`Ollama installed sha256 ${other}`);
    expect(fs.existsSync(t.envFile)).toBe(false);
    const ok = await setup({}, { installed: [{ name: Q3, size: 1, digest: PIN.sha256 }] });
    expect(await ok.wizard.start()).toMatchObject({ state: 'done' });
    expect(ok.fake.pulls).toEqual(['bge-m3:567m']);
  });

  it('rejects retry outside the error state and start outside idle', async () => {
    const t = await setup();
    expect(() => t.wizard.retry()).toThrow(/retry\(\) needs state error, not idle/);
    const first = t.wizard.start();
    expect(t.wizard.start()).toBe(first);
    await first;
    expect(() => t.wizard.start()).toThrow(/start\(\) needs state idle, not done/);
  });
});
