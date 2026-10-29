import os from 'node:os';
import type { Preset, PresetFile } from './schema.js';

const GIB = 1024 ** 3;

export interface TierChoice {
  preset: Preset;
  ramGb: number;
  /** True when the machine has less RAM than the lowest tier asks for; it still gets that tier. */
  belowMinimum: boolean;
}

/** Total RAM in bytes. The override lets tests and developers pretend to be another machine. */
export function detectRamBytes(overrideBytes?: number): number {
  return overrideBytes ?? os.totalmem();
}

/**
 * Picks the highest tier whose minRamGb is not above the machine's RAM in GiB. Macs report their
 * marketed size exactly (16 GB is 17179869184 bytes), so GiB boundaries match the label. A machine
 * below the lowest tier gets the lowest tier rather than nothing, flagged so the caller can warn.
 */
export function chooseTier(presets: PresetFile, totalBytes: number): TierChoice {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error(`invalid total RAM ${totalBytes}`);
  const ramGb = totalBytes / GIB;
  const tiers = [...presets.tiers].sort((a, b) => a.minRamGb - b.minRamGb);
  const lowest = tiers[0];
  if (!lowest) throw new Error('no tiers in presets');
  let preset = lowest;
  for (const t of tiers) if (t.minRamGb <= ramGb) preset = t;
  return { preset, ramGb, belowMinimum: ramGb < lowest.minRamGb };
}
