import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPresets, PresetError, validatePresets } from './schema.js';

const PRESETS_FILE = path.resolve(import.meta.dirname, '../../../config/presets.json');

function base(): { version: number; comment: string; tiers: Record<string, unknown>[] } {
  return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
}

function problemsOf(data: unknown): string[] {
  try {
    validatePresets(data);
  } catch (e) {
    expect(e).toBeInstanceOf(PresetError);
    return (e as PresetError).problems;
  }
  throw new Error('expected validation to fail');
}

describe('config/presets.json', () => {
  it('validates, with tiers 8, 16 and 32 GB and thinking off everywhere', () => {
    const p = loadPresets(PRESETS_FILE);
    expect(p.tiers.map((t) => [t.id, t.minRamGb, t.chatModel])).toEqual([
      ['8gb', 8, 'qwen3:4b'],
      ['16gb', 16, 'qwen3:8b'],
      ['32gb', 32, 'qwen3:14b'],
    ]);
    for (const t of p.tiers) {
      expect(t.reasoningEffort).toBe('off');
      expect(t.embeddingModel).toBe('bge-m3:567m');
      expect(t.comment).toMatch(/starting value/i);
    }
  });
});

describe('validatePresets failures', () => {
  it('rejects a non-object and an empty tier list', () => {
    expect(problemsOf(null)).toEqual(['top level must be an object']);
    expect(problemsOf({ version: 1, comment: 'x', tiers: [] })).toEqual(['tiers must be a non-empty array']);
  });

  it('names every bad field with its path', () => {
    const d = base();
    d.version = 2;
    delete d.tiers[0]!.chatModel;
    d.tiers[0]!.embeddingModel = 'BGE M3';
    d.tiers[1]!.chatMode = 'chat';
    d.tiers[1]!.reasoningEffort = 'on';
    d.tiers[1]!.similarityThreshold = 1.5;
    d.tiers[2]!.maxSnippets = 2.5;
    d.tiers[2]!.extra = true;
    expect(problemsOf(d)).toEqual([
      'version must be 1',
      'tiers[0].chatModel is missing',
      'tiers[0].embeddingModel must be an Ollama model tag such as qwen3:8b',
      'tiers[1].similarityThreshold must be a number from 0 to 1',
      'tiers[1].chatMode must be "query"',
      'tiers[1].reasoningEffort must be "off"',
      'tiers[2].maxSnippets must be an integer from 1 to 32',
      'tiers[2].extra is not a known field',
    ]);
  });

  it('requires ascending RAM and unique ids', () => {
    const d = base();
    d.tiers[1]!.minRamGb = 8;
    d.tiers[2]!.id = '8gb';
    expect(problemsOf(d)).toEqual([
      'tiers[1].minRamGb must be greater than the tier before it',
      'tiers[2].id 8gb is used twice',
    ]);
  });

  it('requires the starting value marker in each comment', () => {
    const d = base();
    d.tiers[0]!.comment = 'measured';
    expect(problemsOf(d)).toEqual(['tiers[0].comment must say these are starting values']);
  });

  it('caps the chunk maximum below the embedding truncation limit', () => {
    const d = base();
    d.tiers[0]!.chunkMaxChars = 3000;
    expect(problemsOf(d)).toEqual(['tiers[0].chunkMaxChars must be an integer from 200 to 2800']);
  });

  it('rejects values that would break the .env file', () => {
    const d = base();
    d.tiers[0]!.ocrLanguages = 'eng#x';
    d.tiers[1]!.chatModel = 'qwen3:8b"';
    expect(problemsOf(d)).toEqual([
      'tiers[0].ocrLanguages must not contain quotes, #, \\ or control characters',
      'tiers[1].chatModel must not contain quotes, #, \\ or control characters',
    ]);
  });

  it('reports a file that is not JSON', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-presets-')), 'p.json');
    fs.writeFileSync(file, '{');
    expect(() => loadPresets(file)).toThrow(/could not be read as JSON/);
  });
});
