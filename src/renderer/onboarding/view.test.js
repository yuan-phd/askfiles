import { describe, expect, it } from 'vitest';
import { formatBytes, indexingText, initialState, progressText, reduce } from './view.js';

const state = (s, extra = {}) => ({ type: 'state', state: s, failedStep: null, error: null, attempt: 1, ...extra });
const setup = (s, extra = {}) => ({ type: 'setup', state: s, failedStep: null, error: null, folder: null, ...extra });
const WIZARD_PENDING = { chooseFolder: 'pending', createLibrary: 'pending', indexing: 'pending' };

describe('reduce', () => {
  it('marks earlier steps done and the current one active', () => {
    let s = initialState();
    for (const name of ['detectRam', 'chooseTier', 'pullModels']) s = reduce(s, state(name));
    expect(s.steps).toEqual({
      detectRam: 'done',
      chooseTier: 'done',
      pullModels: 'active',
      writeConfig: 'pending',
      markOnboarded: 'pending',
      ...WIZARD_PENDING,
    });
    expect(s.phase).toBe('running');
  });

  it('shows the failed step and error, then clears them on retry', () => {
    let s = reduce(initialState(), state('pullModels'));
    s = reduce(s, state('error', { failedStep: 'pullModels', error: 'pull qwen3:8b failed: offline' }));
    expect(s).toMatchObject({ phase: 'error', error: 'pull qwen3:8b failed: offline' });
    expect(s.steps.pullModels).toBe('failed');
    s = reduce(s, state('retry', { attempt: 2 }));
    expect(s).toMatchObject({ phase: 'running', error: null, attempt: 2 });
    s = reduce(s, state('pullModels', { attempt: 2 }));
    expect(s.steps.pullModels).toBe('active');
  });

  it('keeps tier and progress, and the wizard finishing leaves the setup steps to come', () => {
    let s = reduce(initialState(), {
      type: 'tier',
      ramGb: 16,
      label: '16 GB',
      belowMinimum: false,
      tierId: '16gb',
      chatModel: 'qwen3:8b',
      embeddingModel: 'bge-m3:567m',
    });
    s = reduce(s, {
      type: 'progress',
      model: 'qwen3:8b',
      index: 1,
      count: 2,
      status: 'pulling x',
      completedBytes: 2.6e9,
      totalBytes: 5.2e9,
      percent: 50,
    });
    s = reduce(s, state('done'));
    expect(s.tier).toEqual({ ramGb: 16, label: '16 GB', belowMinimum: false });
    expect(progressText(s.progress)).toBe('Download 2 of 2: 2.6 GB of 5.2 GB (50%)');
    expect(Object.values(s.steps)).toEqual([...Array(5).fill('done'), 'pending', 'pending', 'pending']);
    expect(s.phase).not.toBe('done');
  });

  it('waits for the folder, then shows the folder, library, indexing counts and done', () => {
    let s = reduce(initialState(), state('done'));
    s = reduce(s, setup('chooseFolder'));
    expect(s).toMatchObject({ phase: 'folder', folder: null });
    expect(s.steps).toMatchObject({ markOnboarded: 'done', chooseFolder: 'active', createLibrary: 'pending' });
    s = reduce(s, setup('chooseFolder', { folder: '/Users/u/Documents' }));
    expect(s).toMatchObject({ phase: 'running', folder: '/Users/u/Documents' });
    s = reduce(s, setup('createLibrary', { folder: '/Users/u/Documents' }));
    s = reduce(s, setup('indexing', { folder: '/Users/u/Documents' }));
    s = reduce(s, {
      type: 'indexing',
      status: { state: 'working', pending: 3, indexed: 9, current: null, deadLetters: [{ path: '/a.pdf' }] },
    });
    expect(s.steps).toMatchObject({ chooseFolder: 'done', createLibrary: 'done', indexing: 'active' });
    expect(indexingText(s.indexing)).toBe('9 documents read, 3 to go, 1 could not be read');
    s = reduce(s, setup('done', { folder: '/Users/u/Documents' }));
    expect(s.phase).toBe('done');
    expect(Object.values(s.steps)).toEqual(Array(8).fill('done'));
  });

  it('marks a failed setup step and clears it on the retry', () => {
    let s = reduce(initialState(), setup('createLibrary', { folder: '/d' }));
    s = reduce(
      s,
      setup('error', { failedStep: 'createLibrary', error: 'POST /v1/workspace/new failed (500)', folder: '/d' }),
    );
    expect(s).toMatchObject({ phase: 'error', error: 'POST /v1/workspace/new failed (500)' });
    expect(s.steps.createLibrary).toBe('failed');
    s = reduce(s, setup('createLibrary', { folder: '/d' }));
    expect(s).toMatchObject({ phase: 'running', error: null });
    expect(s.steps.createLibrary).toBe('active');
  });

  it('keeps the wizard error when the first run reports the model step failed', () => {
    let s = reduce(initialState(), state('pullModels'));
    s = reduce(s, state('error', { failedStep: 'pullModels', error: 'pull failed' }));
    s = reduce(s, setup('error', { failedStep: 'models', error: 'pull failed' }));
    expect(s).toMatchObject({ phase: 'error', error: 'pull failed' });
    expect(s.steps.pullModels).toBe('failed');
    s = reduce(s, setup('models'));
    expect(s).toMatchObject({ phase: 'running', error: null });
  });

  it('does not mutate the state it is given', () => {
    const s = initialState();
    reduce(s, state('detectRam'));
    expect(s.steps.detectRam).toBe('pending');
  });
});

describe('formatting', () => {
  it('formats bytes in MB and GB', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(45_960_996)).toBe('46 MB');
    expect(formatBytes(1_157_672_268)).toBe('1.2 GB');
  });

  it('counts documents in the indexing line', () => {
    expect(indexingText(null)).toBe('');
    expect(indexingText({ indexed: 1, pending: 0, failed: 0 })).toBe('1 document read');
  });

  it('says starting before the first layer is known', () => {
    expect(progressText({ index: 0, count: 1, completedBytes: 0, totalBytes: 0, percent: 0 })).toBe(
      'Download: starting',
    );
  });
});
