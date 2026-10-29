import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { OllamaClient } from '../ollama/client.js';
import { startFakeOllama, type FakeOllama } from '../ollama/__fixtures__/fake-ollama.js';
import { ModelManager } from './manager.js';

let fake: FakeOllama | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function setup() {
  fake = await startFakeOllama({
    installed: [
      { name: 'qwen3:8b', size: 5 },
      { name: 'qwen3:4b', size: 2 },
      { name: 'bge-m3:567m', size: 1, capabilities: ['embedding'] },
    ],
  });
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-models-')), '.env');
  fs.writeFileSync(envFile, 'SIG_KEY="k"\nOLLAMA_MODEL_PREF="qwen3:8b"\nEMBEDDING_MODEL_PREF="bge-m3:567m"\n');
  let restarts = 0;
  const manager = new ModelManager({
    ollama: new OllamaClient({ baseUrl: fake.url }),
    envFile,
    restartServer: async () => {
      restarts += 1;
    },
  });
  return { fake, manager, envFile, restarts: () => restarts };
}

describe('ModelManager', () => {
  it('lists installed models with the active roles from the server .env', async () => {
    const t = await setup();
    expect((await t.manager.list()).map((m) => [m.name, m.role])).toEqual([
      ['qwen3:8b', 'chat'],
      ['qwen3:4b', null],
      ['bge-m3:567m', 'embedding'],
    ]);
  });

  it('pulls by tag with progress', async () => {
    const t = await setup();
    const percents: number[] = [];
    await t.manager.pull('qwen3:14b', (p) => percents.push(p.percent));
    expect(percents.at(-1)).toBe(100);
    expect((await t.manager.list()).some((m) => m.name === 'qwen3:14b')).toBe(true);
  });

  it('deletes an inactive model and refuses the active ones', async () => {
    const t = await setup();
    await t.manager.remove('qwen3:4b');
    expect(t.fake.deletes).toEqual(['qwen3:4b']);
    await expect(t.manager.remove('qwen3:8b')).rejects.toThrow(/active chat model/);
    await expect(t.manager.remove('bge-m3:567m')).rejects.toThrow(/active embedding model/);
    expect(t.fake.deletes).toEqual(['qwen3:4b']);
  });

  it('switches the chat model in the .env, keeps the rest, and restarts the server', async () => {
    const t = await setup();
    await t.manager.switchChatModel('qwen3:4b');
    const text = fs.readFileSync(t.envFile, 'utf8');
    expect(text).toBe('SIG_KEY="k"\nOLLAMA_MODEL_PREF="qwen3:4b"\nEMBEDDING_MODEL_PREF="bge-m3:567m"\n');
    expect(util.parseEnv(text).OLLAMA_MODEL_PREF).toBe('qwen3:4b');
    expect(t.restarts()).toBe(1);
  });

  it('refuses to switch to a missing model or an embedding model', async () => {
    const t = await setup();
    await expect(t.manager.switchChatModel('qwen3:32b')).rejects.toThrow(/not installed/);
    await expect(t.manager.switchChatModel('bge-m3:567m')).rejects.toThrow(/cannot answer questions \(embedding\)/);
    expect(t.restarts()).toBe(0);
  });
});
