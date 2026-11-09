import { describe, expect, it } from 'vitest';
import { progressText } from './progress.js';

describe('progressText', () => {
  it('says what the answer is waiting for', () => {
    expect(progressText({ stage: 'searching' })).toBe('Searching your documents');
    expect(progressText({ stage: 'judging', file: 'Pump Station Procedure', n: 3, total: 15 })).toBe(
      'Checking sections in Pump Station Procedure (3 of 15)',
    );
    expect(progressText({ stage: 'writing' })).toBe('Writing the answer');
    expect(progressText({ stage: 'unknown' })).toBeNull();
    expect(progressText(null)).toBeNull();
  });
});
