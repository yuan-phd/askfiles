import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPresets } from './schema.js';
import { chooseTier, detectRamBytes } from './tier.js';

const presets = loadPresets(path.resolve(import.meta.dirname, '../../../config/presets.json'));
const GIB = 1024 ** 3;

describe('chooseTier at the boundaries', () => {
  it.each([
    [7.9, '8gb', true],
    [8, '8gb', false],
    [15.9, '8gb', false],
    [16, '16gb', false],
    [32, '32gb', false],
    [64, '32gb', false],
  ])('%s GiB gets %s (below minimum: %s)', (gb, id, below) => {
    const choice = chooseTier(presets, gb * GIB);
    expect(choice.preset.id).toBe(id);
    expect(choice.belowMinimum).toBe(below);
    expect(choice.ramGb).toBeCloseTo(gb);
  });

  it('matches the exact byte count a 16 GB Mac reports', () => {
    expect(chooseTier(presets, 17179869184).preset.id).toBe('16gb');
    expect(chooseTier(presets, 17179869184 - 1).preset.id).toBe('8gb');
  });

  it('rejects a nonsense RAM value', () => {
    expect(() => chooseTier(presets, 0)).toThrow(/invalid total RAM/);
    expect(() => chooseTier(presets, NaN)).toThrow(/invalid total RAM/);
  });
});

describe('detectRamBytes', () => {
  it('uses the override, else os.totalmem', () => {
    expect(detectRamBytes(8 * GIB)).toBe(8 * GIB);
    expect(detectRamBytes()).toBeGreaterThan(0);
  });
});
