import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseStartPage, developerEnabled, presetFolder, presetsFilePath } from './app-mode.js';
import {
  emptyShellState,
  isSetupComplete,
  loadShellState,
  saveShellState,
  SHELL_STATE_FILE,
  type ShellState,
} from './shell-state.js';

const complete: ShellState = {
  ...emptyShellState(),
  apiKey: 'K',
  setupCompletedAt: '2026-10-29T10:00:00.000Z',
  libraries: [{ ...emptyShellState().libraries[0]!, workspaceSlug: 'askfiles-library' }],
};

describe('start page', () => {
  it('shows onboarding until setup is complete, then the Ask page', () => {
    expect(chooseStartPage({}, emptyShellState())).toBe('onboarding');
    expect(chooseStartPage({}, { ...complete, setupCompletedAt: null })).toBe('onboarding');
    expect(chooseStartPage({}, { ...complete, apiKey: null })).toBe('onboarding');
    expect(chooseStartPage({}, { ...complete, libraries: emptyShellState().libraries })).toBe('onboarding');
    expect(chooseStartPage({}, complete)).toBe('ask');
  });

  it('opens the upstream interface only with ASKFILES_UPSTREAM_UI=1', () => {
    expect(chooseStartPage({ ASKFILES_UPSTREAM_UI: '1' }, complete)).toBe('upstream');
    expect(chooseStartPage({ ASKFILES_UPSTREAM_UI: '1' }, emptyShellState())).toBe('upstream');
    expect(chooseStartPage({ ASKFILES_UPSTREAM_UI: 'true' }, complete)).toBe('ask');
  });

  it('takes presets file and library folder from the environment for the smoke test', () => {
    expect(presetsFilePath({}, '/app.asar')).toBe('/app.asar/config/presets.json');
    expect(presetsFilePath({ ASKFILES_PRESETS_FILE: '/tmp/p.json' }, '/app.asar')).toBe('/tmp/p.json');
    expect(presetFolder({})).toBeNull();
    expect(presetFolder({ ASKFILES_LIBRARY_FOLDER: '/tmp/docs' })).toBe('/tmp/docs');
  });

  it('shows the developer page only with ASKFILES_DEVELOPER=1', () => {
    expect(developerEnabled({})).toBe(false);
    expect(developerEnabled({ ASKFILES_DEVELOPER: 'true' })).toBe(false);
    expect(developerEnabled({ ASKFILES_DEVELOPER: '1' })).toBe(true);
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
    fs.writeFileSync(file, '{"version": 3}');
    expect(loadShellState(dir, (m) => logs.push(m))).toEqual(emptyShellState());
    fs.writeFileSync(file, 'not json');
    expect(loadShellState(dir, (m) => logs.push(m))).toEqual(emptyShellState());
    expect(logs).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('shell.json version 2', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-state-'));

  it('moves a version 1 file to the default library with its folder linked', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, SHELL_STATE_FILE),
      JSON.stringify({
        version: 1,
        folder: '/Users/u/Documents',
        workspaceSlug: 'askfiles-library',
        apiKey: 'K',
        setupCompletedAt: '2026-10-29T10:00:00.000Z',
      }),
    );
    const s = loadShellState(dir);
    expect(s.migrated).toBe(1);
    expect(s).toMatchObject({
      version: 2,
      apiKey: 'K',
      setupCompletedAt: '2026-10-29T10:00:00.000Z',
      currentLibrary: 'all-files',
      settings: { answerScope: 'balanced', answerModel: 'better', contextLength: null },
    });
    expect(s.libraries).toEqual([
      {
        id: 'all-files',
        name: 'All files',
        workspaceSlug: 'askfiles-library',
        folders: [{ id: 'folder-1', path: '/Users/u/Documents', addedAt: expect.any(String) }],
        createdAt: expect.any(String),
      },
    ]);
    expect(isSetupComplete(s)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the default library first with its fixed name, drops bad records and bad settings', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, SHELL_STATE_FILE),
      JSON.stringify({
        version: 2,
        apiKey: 'K',
        setupCompletedAt: null,
        currentLibrary: 'gone',
        libraries: [
          { id: 'lib-1', name: 'Work', workspaceSlug: 'w', folders: [{ id: 'folder-1', path: '/w' }, { path: '/x' }] },
          { id: 'all-files', name: 'Renamed', workspaceSlug: 'askfiles-library', folders: [] },
          { id: 'BAD ID', name: 'Bad' },
          { id: 'lib-1', name: 'Duplicate' },
        ],
        settings: { answerScope: 'wide', answerModel: 'faster', contextLength: 5000 },
      }),
    );
    const s = loadShellState(dir);
    expect(s.libraries.map((l) => [l.id, l.name])).toEqual([
      ['all-files', 'All files'],
      ['lib-1', 'Work'],
    ]);
    expect(s.libraries[1]!.folders.map((f) => f.path)).toEqual(['/w']);
    expect(s.currentLibrary).toBe('all-files');
    expect(s.settings).toEqual({ answerScope: 'balanced', answerModel: 'faster', contextLength: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
