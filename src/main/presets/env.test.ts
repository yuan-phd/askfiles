import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { describe, expect, it } from 'vitest';
import { renderServerEnv } from '../process-manager/env-file.js';
import {
  mergeEnvText,
  NOT_KEPT_BY_DUMPENV,
  presetEnv,
  presetHeader,
  presetSpawnEnv,
  workspaceSettings,
  writeServerEnv,
} from './env.js';
import { loadPresets } from './schema.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const presets = loadPresets(path.join(ROOT, 'config/presets.json'));
const tier16 = presets.tiers.find((t) => t.id === '16gb')!;
const OLLAMA = 'http://127.0.0.1:11434';

function counter(): () => string {
  let n = 0;
  return () => `test-secret-${++n}`;
}

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-env-')), 'server', '.env');
}

describe('server .env for the 16 GB tier', () => {
  it('matches the fixture byte for byte after the process manager wrote the base file', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderServerEnv({ serverPort: 3001, collectorPort: 8888 }, counter()));
    writeServerEnv(file, presetEnv(tier16, { ollamaBaseUrl: OLLAMA + '/' }), { header: presetHeader(tier16) });
    const expected = fs.readFileSync(path.join(import.meta.dirname, '__fixtures__/server-16gb.env'), 'utf8');
    expect(fs.readFileSync(file, 'utf8')).toBe(expected);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: writing the same preset again changes nothing', () => {
    const once = mergeEnvText(renderServerEnv({}, counter()), presetEnv(tier16, { ollamaBaseUrl: OLLAMA }), 'h');
    expect(mergeEnvText(once, presetEnv(tier16, { ollamaBaseUrl: OLLAMA }), 'h')).toBe(once);
  });

  it('creates a missing file with secrets first', () => {
    const file = tmpFile();
    writeServerEnv(file, presetEnv(tier16, { ollamaBaseUrl: OLLAMA }), {
      header: presetHeader(tier16),
      secret: counter(),
    });
    const env = util.parseEnv(fs.readFileSync(file, 'utf8'));
    expect(env.JWT_SECRET).toBe('test-secret-1');
    expect(env.SIG_SALT).toBe('test-secret-3');
    expect(env.OLLAMA_MODEL_PREF).toBe('qwen3:8b');
    expect(env.SERVER_PORT).toBeUndefined();
  });
});

describe('mergeEnvText', () => {
  it('replaces dumpENV style lines in place, drops duplicates and keeps everything else', () => {
    const dumped = [
      '# Auto-dump ENV from system call on 10:00:00',
      "OLLAMA_MODEL_PREF='qwen3:4b'",
      "SIG_KEY='keep-me'",
      "OLLAMA_MODEL_PREF='older'",
    ].join('\n');
    expect(mergeEnvText(dumped, [['OLLAMA_MODEL_PREF', 'qwen3:8b']])).toBe(
      ['# Auto-dump ENV from system call on 10:00:00', 'OLLAMA_MODEL_PREF="qwen3:8b"', "SIG_KEY='keep-me'", ''].join(
        '\n',
      ),
    );
  });

  it('refuses a value that would break the line', () => {
    expect(() => mergeEnvText('', [['A', 'x"y']])).toThrow(/A contains a quote/);
  });
});

describe('variable names against upstream', () => {
  const server = path.join(ROOT, 'upstream/server');
  const updateEnv = fs.readFileSync(path.join(server, 'utils/helpers/updateENV.js'), 'utf8');
  const patch007 = fs.readFileSync(path.join(ROOT, 'patches/007-reasoning-effort-api.patch'), 'utf8');
  const keys = presetEnv(tier16, { ollamaBaseUrl: OLLAMA }).map(([k]) => k);

  it('every preset variable is read by the server or by our patch 007', () => {
    const readByServer = (k: string) =>
      new RegExp(`envKey: "${k}"|process\\.env\\.${k}\\b|process\\.env\\?\\.${k}\\b|"${k}" in process\\.env`).test(
        updateEnv,
      ) || grepServer(server, k);
    for (const k of keys) {
      if (k === 'DEFAULT_REASONING_EFFORT') expect(patch007).toContain(`process.env.${k}`);
      else expect(readByServer(k), k).toBe(true);
    }
  });

  it('NOT_KEPT_BY_DUMPENV is exactly the preset keys missing from the dumpENV allow list', () => {
    const dump = updateEnv.slice(updateEnv.indexOf('function dumpENV()'));
    const kept = (k: string) => new RegExp(`envKey: "${k}"`).test(updateEnv) || dump.includes(`"${k}"`);
    expect(keys.filter((k) => !kept(k))).toEqual([...NOT_KEPT_BY_DUMPENV]);
    expect(presetSpawnEnv(tier16)).toEqual({ DEFAULT_REASONING_EFFORT: 'off' });
  });
});

function grepServer(dir: string, key: string): boolean {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'public' || entry.name === 'storage') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (grepServer(p, key)) return true;
    } else if (entry.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes(`process.env.${key}`)) {
      return true;
    }
  }
  return false;
}

describe('workspaceSettings', () => {
  it('maps the preset to the upstream workspace columns', () => {
    expect(workspaceSettings(tier16)).toEqual({
      chatMode: 'query',
      similarityThreshold: 0.5,
      topN: 4,
      openAiTemp: 0.1,
      openAiPrompt: tier16.systemPrompt,
    });
  });
});
