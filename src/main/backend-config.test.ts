import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledBackendConfig, bundledOllamaEnv, presetServerEnv } from './backend-config.js';
import { fakeConfig, fakeTreeKill, readRecord, tmpDir } from './process-manager/__fixtures__/helpers.js';
import { ProcessManager } from './process-manager/index.js';

const res = '/Applications/AskFiles.app/Contents/Resources';
const cfg = bundledBackendConfig({
  resourcesPath: res,
  dataDir: '/Users/u/Library/Application Support/AskFiles',
  logDir: '/Users/u/Library/Logs/AskFiles',
  nodePath: '/Applications/AskFiles.app/Contents/MacOS/AskFiles',
});

const winManagers: ProcessManager[] = [];
afterEach(async () => {
  await Promise.all(winManagers.splice(0).map((m) => m.stop()));
});

describe('bundledBackendConfig', () => {
  it('uses an external Ollama for a dev run and spawns none', () => {
    const dev = bundledBackendConfig({
      resourcesPath: '/repo/upstream',
      dataDir: '/d',
      logDir: '/l',
      nodePath: '/usr/local/bin/node',
      externalOllamaPort: 11434,
    });
    expect(dev.externalOllamaPort).toBe(11434);
    expect(dev.ollama).toBeUndefined();
    expect(dev.server.args).toEqual(['/repo/upstream/server/index.js']);
    expect(cfg.externalOllamaPort).toBeUndefined();
  });

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
    expect(cfg.ollama!.command).toBe(`${res}/ollama/ollama`);
    expect(cfg.ollama!.env).toEqual({
      OLLAMA_MODELS: '/Users/u/Library/Application Support/AskFiles/ollama',
      OLLAMA_NO_CLOUD: '1',
      OLLAMA_REMOTES: '127.0.0.1',
      HOME: '/Users/u/Library/Application Support/AskFiles/ollama-home',
    });
    expect(cfg.dataDir).toBe('/Users/u/Library/Application Support/AskFiles');
    expect(cfg.logDir).toBe('/Users/u/Library/Logs/AskFiles');
    expect(cfg.killProcessGroup).toBe(true);
  });

  it('runs ollama.exe from resources on Windows, with Windows paths and a tree kill instead of process groups', () => {
    const wres = 'C:\\Users\\u\\AppData\\Local\\Programs\\AskFiles\\resources';
    const data = 'C:\\Users\\u\\AppData\\Local\\AskFiles';
    const w = bundledBackendConfig({
      platform: 'win32',
      systemRoot: 'C:\\WINDOWS',
      resourcesPath: wres,
      dataDir: data,
      logDir: `${data}\\logs`,
      nodePath: 'C:\\Users\\u\\AppData\\Local\\Programs\\AskFiles\\AskFiles.exe',
    });
    expect(w.ollama).toEqual({
      command: `${wres}\\ollama\\ollama.exe`,
      args: ['serve'],
      cwd: data,
      env: {
        OLLAMA_MODELS: `${data}\\ollama`,
        OLLAMA_NO_CLOUD: '1',
        OLLAMA_REMOTES: '127.0.0.1',
        HOME: `${data}\\ollama-home`,
        USERPROFILE: `${data}\\ollama-home`,
      },
    });
    expect(w.server.args).toEqual([`${wres}\\server\\index.js`]);
    expect(w.server.cwd).toBe(`${wres}\\server`);
    expect(w.collector.args).toEqual([`${wres}\\collector\\index.js`]);
    expect(w.migrate.args[0]).toBe(`${wres}\\server\\node_modules\\prisma\\build\\index.js`);
    expect(w.server.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(w.killProcessGroup).toBeUndefined();
    expect(w.treeKill).toEqual({
      command: 'C:\\WINDOWS\\System32\\taskkill.exe',
      args: ['/PID', '{pid}', '/T', '/F'],
    });
    // Every child binds to loopback only, so Windows Firewall never asks on first launch.
    expect(w.host).toBeUndefined();
    expect(cfg.treeKill).toBeUndefined();
  });

  it('runs the Windows configuration through the manager with fake children and binds them to 127.0.0.1', async () => {
    const dir = tmpDir();
    const w = bundledBackendConfig({ platform: 'win32', resourcesPath: dir, dataDir: dir, logDir: dir, nodePath: 'x' });
    const m = new ProcessManager(
      fakeConfig(dir, { killProcessGroup: false, treeKill: fakeTreeKill(dir), host: w.host }),
    );
    winManagers.push(m);
    const s = await m.start();
    const ports = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'ports.json'), 'utf8')) as { host: string };
    expect(ports.host).toBe('127.0.0.1');
    for (const r of readRecord(dir).filter((x) => x.event === 'start' && x.name === 'server')) {
      expect(r.env?.ANYTHING_LLM_BIND_HOST).toBe('127.0.0.1');
    }
    await m.stop();
    expect(
      readRecord(dir)
        .filter((r) => r.event === 'taskkill')
        .map((r) => r.pid),
    ).toEqual([s.processes.server.pid, s.processes.collector.pid, s.processes.ollama.pid]);
  });

  // The offline test of 2026-11-08 saw the bundled Ollama call ollama.com at every start and write
  // ~/.ollama/cache. A parent environment that says otherwise must not win.
  for (const platform of ['darwin', 'win32'] as const) {
    it(`gives the bundled Ollama no cloud and a home inside the data directory on ${platform}`, async () => {
      const dir = tmpDir();
      const data = path.join(dir, 'data');
      const spec = bundledBackendConfig({
        platform,
        resourcesPath: dir,
        dataDir: data,
        logDir: dir,
        nodePath: 'x',
      }).ollama!;
      const fakeOllama = fakeConfig(dir).ollama!;
      const m = new ProcessManager(
        fakeConfig(dir, {
          ollama: { ...fakeOllama, env: spec.env },
          baseEnv: {
            ...process.env,
            OLLAMA_NO_CLOUD: '0',
            OLLAMA_REMOTES: 'ollama.com',
            HOME: '/Users/someone',
            USERPROFILE: 'C:\\Users\\someone',
          },
          ...(platform === 'win32' ? { killProcessGroup: false, treeKill: fakeTreeKill(dir) } : {}),
        }),
      );
      winManagers.push(m);
      await m.start();
      const env = readRecord(dir).find((r) => r.event === 'start' && r.name === 'ollama')!.env!;
      const join = platform === 'win32' ? path.win32.join : path.posix.join;
      expect(env).toMatchObject({
        OLLAMA_NO_CLOUD: '1',
        OLLAMA_REMOTES: '127.0.0.1',
        OLLAMA_MODELS: join(data, 'ollama'),
        HOME: join(data, 'ollama-home'),
      });
      expect(env.USERPROFILE).toBe(platform === 'win32' ? join(data, 'ollama-home') : 'C:\\Users\\someone');
      expect(bundledOllamaEnv(data, platform === 'win32')).toEqual(spec.env);
      await m.stop();
    });
  }

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
