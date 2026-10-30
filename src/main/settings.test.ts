import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseTier, loadPresets } from './presets/index.js';
import { checkSettingsChange, effectivePreset, modelChoices, settingsEnv, settingsView } from './settings.js';
import { defaultSettings } from './shell-state.js';

const presets = loadPresets(path.resolve(import.meta.dirname, '../../config/presets.json'));
const GB = 1024 ** 3;
const tier = (gb: number) => chooseTier(presets, gb * GB).preset;

describe('settings', () => {
  it('offers this tier as Better and the tier below as Faster; the lowest tier has no Faster', () => {
    expect(modelChoices(presets, tier(16))).toEqual({
      better: { choice: 'better', model: 'qwen3:8b', tierLabel: '16 GB' },
      faster: { choice: 'faster', model: 'qwen3:4b', tierLabel: '8 GB' },
    });
    expect(modelChoices(presets, tier(64)).faster).toMatchObject({ model: 'qwen3:8b' });
    expect(modelChoices(presets, tier(8))).toEqual({
      better: { choice: 'better', model: 'qwen3:4b', tierLabel: '8 GB' },
      faster: null,
    });
  });

  it('applies model and context length to the preset and its .env lines', () => {
    const machine = tier(16);
    expect(effectivePreset(presets, machine, defaultSettings())).toEqual(machine);
    const p = effectivePreset(presets, machine, { answerScope: 'strict', answerModel: 'faster', contextLength: 16384 });
    expect([p.chatModel, p.contextLength, p.embeddingModel]).toEqual(['qwen3:4b', 16384, machine.embeddingModel]);
    expect(settingsEnv(p)).toEqual([
      ['OLLAMA_MODEL_PREF', 'qwen3:4b'],
      ['OLLAMA_MODEL_TOKEN_LIMIT', '16384'],
    ]);
    // Faster without a lower tier stays on this tier's model.
    expect(effectivePreset(presets, tier(8), { ...defaultSettings(), answerModel: 'faster' }).chatModel).toBe(
      'qwen3:4b',
    );
  });

  it('checks a change from a page', () => {
    const models = modelChoices(presets, tier(16));
    expect(checkSettingsChange({ answerScope: 'broad', other: 1 }, models)).toEqual({ answerScope: 'broad' });
    expect(checkSettingsChange({ contextLength: null, answerModel: 'faster' }, models)).toEqual({
      contextLength: null,
      answerModel: 'faster',
    });
    expect(checkSettingsChange(null, models)).toEqual({});
    expect(() => checkSettingsChange({ answerScope: 'wide' }, models)).toThrow('Unknown answer scope.');
    expect(() => checkSettingsChange({ answerModel: 'best' }, models)).toThrow('Unknown answer model.');
    expect(() => checkSettingsChange({ contextLength: 5000 }, models)).toThrow('Unknown context length.');
    expect(() => checkSettingsChange({ answerModel: 'faster' }, modelChoices(presets, tier(8)))).toThrow(
      'This Mac has no faster model to choose.',
    );
  });

  it('describes the page: values, model choices, context choices with the preset default', () => {
    const v = settingsView(presets, tier(16), defaultSettings());
    expect(v).toMatchObject({
      values: { answerScope: 'balanced', answerModel: 'better', contextLength: null },
      contextDefault: 8192,
      contextChoices: [4096, 8192, 16384],
      scopes: ['strict', 'balanced', 'broad'],
    });
  });
});
