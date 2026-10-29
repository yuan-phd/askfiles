import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledBackendConfig } from './backend-config.js';

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
