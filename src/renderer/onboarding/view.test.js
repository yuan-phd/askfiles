import { describe, expect, it } from 'vitest';
import { formatBytes, initialState, progressText, reduce } from './view.js';

const state = (s, extra = {}) => ({ type: 'state', state: s, failedStep: null, error: null, attempt: 1, ...extra });

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

  it('keeps tier and progress and ends with every step done', () => {
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
    expect(Object.values(s.steps)).toEqual(Array(5).fill('done'));
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

  it('says starting before the first layer is known', () => {
    expect(progressText({ index: 0, count: 1, completedBytes: 0, totalBytes: 0, percent: 0 })).toBe(
      'Download: starting',
    );
  });
});
