import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledBackendConfig, presetServerEnv } from './backend-config.js';
import { fakeConfig, readRecord, tmpDir } from './process-manager/__fixtures__/helpers.js';
import { ProcessManager } from './process-manager/index.js';

const res = '/Applications/AskFiles.app/Contents/Resources';
const cfg = bundledBackendConfig({
  resourcesPath: res,
  dataDir: '/Users/u/Library/Application Support/AskFiles',
  logDir: '/Users/u/Library/Logs/AskFiles',
  nodePath: '/Applications/AskFiles.app/Contents/MacOS/AskFiles',
});

describe('bundledBackendConfig', () => {
  it('runs server and collector from Resources with the app binary as Node', () => {
    expect(cfg.server).toEqual({
      command: '/Applications/AskFiles.app/Contents/MacOS/AskFiles',
      args: [`${res}/server/index.js`],
      cwd: `${res}/server`,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(cfg.collector.args).toEqual([`${res}/collector/index.js`]);
    expect(cfg.migrate.args.slice(0, 3)).toEqual([
      `${res}/server/node_modules/prisma/build/index.js`,
      'migrate',
      'deploy',
    ]);
    expect(cfg.migrate.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('keeps models and all writable data in the data directory', () => {
    expect(cfg.ollama.command).toBe(`${res}/ollama/ollama`);
    expect(cfg.ollama.env).toEqual({ OLLAMA_MODELS: '/Users/u/Library/Application Support/AskFiles/ollama' });
    expect(cfg.dataDir).toBe('/Users/u/Library/Application Support/AskFiles');
    expect(cfg.logDir).toBe('/Users/u/Library/Logs/AskFiles');
    expect(cfg.killProcessGroup).toBe(true);
  });

  it('matches the folder names electron-builder.yml puts under Resources', () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8');
    for (const to of ['server', 'collector', 'ollama']) expect(yml).toMatch(new RegExp(`^\\s+to: ${to}$`, 'm'));
  });
});

const PRESETS = path.join(__dirname, '..', '..', 'config', 'presets.json');
const GIB = 1024 ** 3;

describe('preset values in the server spawn environment', () => {
  const managers: ProcessManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.stop()));
  });

  it('turns thinking off for every tier of config/presets.json', () => {
    for (const gb of [4, 8, 16, 64]) {
      expect(presetServerEnv(PRESETS, gb * GIB)).toEqual({ DEFAULT_REASONING_EFFORT: 'off' });
    }
  });

  it('puts them in the server spec without letting them replace ELECTRON_RUN_AS_NODE', () => {
    const c = bundledBackendConfig({
      resourcesPath: res,
      dataDir: '/d',
      logDir: '/l',
      nodePath: '/n',
      serverEnv: { DEFAULT_REASONING_EFFORT: 'off', ELECTRON_RUN_AS_NODE: '0' },
    });
    expect(c.server.env).toEqual({ DEFAULT_REASONING_EFFORT: 'off', ELECTRON_RUN_AS_NODE: '1' });
    expect(c.collector.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('reaches the server at every start even after dumpENV dropped the key from .env', async () => {
    const dir = tmpDir();
    const envFile = path.join(dir, 'data', 'server', '.env');
    const base = fakeConfig(dir);
    const m = new ProcessManager({
      ...base,
      server: { ...base.server, env: { ...presetServerEnv(PRESETS, 16 * GIB) } },
    });
    managers.push(m);
    // What upstream leaves after a settings change: its allow list, without DEFAULT_REASONING_EFFORT.
    const dumped = 'JWT_SECRET="j"\nSIG_KEY="k"\nSIG_SALT="s"\nLLM_PROVIDER="ollama"\n';
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, dumped);
    await m.start();
    await m.stop();
    // A stale value in the file must lose too.
    fs.writeFileSync(envFile, dumped + 'DEFAULT_REASONING_EFFORT="high"\n');
    await m.start();
    const starts = readRecord(dir).filter((r) => r.name === 'server' && r.event === 'start');
    expect(starts).toHaveLength(2);
    for (const s of starts) expect(s.env?.DEFAULT_REASONING_EFFORT).toBe('off');
  });
});
