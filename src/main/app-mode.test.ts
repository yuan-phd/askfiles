import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseStartPage, presetFolder, presetsFilePath } from './app-mode.js';
import { emptyShellState, isSetupComplete, loadShellState, saveShellState, SHELL_STATE_FILE } from './shell-state.js';

const complete = {
  ...emptyShellState(),
  folder: '/Users/u/Documents',
  workspaceSlug: 'askfiles-library',
  apiKey: 'K',
  setupCompletedAt: '2026-10-29T10:00:00.000Z',
};

describe('start page', () => {
  it('shows onboarding until setup is complete, then the search page', () => {
    expect(chooseStartPage({}, emptyShellState())).toBe('onboarding');
    expect(chooseStartPage({}, { ...complete, setupCompletedAt: null })).toBe('onboarding');
    expect(chooseStartPage({}, { ...complete, apiKey: null })).toBe('onboarding');
    expect(chooseStartPage({}, complete)).toBe('search');
  });

  it('opens the upstream interface only with ASKFILES_UPSTREAM_UI=1', () => {
    expect(chooseStartPage({ ASKFILES_UPSTREAM_UI: '1' }, complete)).toBe('upstream');
    expect(chooseStartPage({ ASKFILES_UPSTREAM_UI: '1' }, emptyShellState())).toBe('upstream');
    expect(chooseStartPage({ ASKFILES_UPSTREAM_UI: 'true' }, complete)).toBe('search');
  });

  it('takes presets file and library folder from the environment for the smoke test', () => {
    expect(presetsFilePath({}, '/app.asar')).toBe('/app.asar/config/presets.json');
    expect(presetsFilePath({ ASKFILES_PRESETS_FILE: '/tmp/p.json' }, '/app.asar')).toBe('/tmp/p.json');
    expect(presetFolder({})).toBeNull();
    expect(presetFolder({ ASKFILES_LIBRARY_FOLDER: '/tmp/docs' })).toBe('/tmp/docs');
  });
});

describe('shell.json', () => {
  it('round-trips with mode 0600 and treats a missing or damaged file as not set up', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-state-'));
    expect(loadShellState(dir)).toEqual(emptyShellState());
    saveShellState(dir, complete);
    const file = path.join(dir, SHELL_STATE_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadShellState(dir)).toEqual(complete);
    expect(isSetupComplete(loadShellState(dir))).toBe(true);

    const logs: string[] = [];
    fs.writeFileSync(file, '{"version": 2}');
    expect(loadShellState(dir, (m) => logs.push(m))).toEqual(emptyShellState());
    fs.writeFileSync(file, 'not json');
    expect(loadShellState(dir, (m) => logs.push(m))).toEqual(emptyShellState());
    expect(logs).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
