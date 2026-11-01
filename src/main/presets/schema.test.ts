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
  it('validates the phase 2 result: Ask off on 8 GB, pinned Q3_K_M on 16 GB, q4_K_M on 32 GB, context 8192', () => {
    const p = loadPresets(PRESETS_FILE);
    expect(p.tiers.map((t) => [t.id, t.minRamGb, t.chatModel])).toEqual([
      ['8gb', 8, null],
      ['16gb', 16, 'hf.co/unsloth/Qwen3-14B-GGUF:Q3_K_M'],
      ['32gb', 32, 'qwen3:14b-q4_K_M'],
    ]);
    expect(p.tiers[1]!.chatModelFile).toEqual({
      repository: 'unsloth/Qwen3-14B-GGUF',
      revision: 'a04a82c4739b3ef5fa6da7d10261db2c67dd1985',
      file: 'Qwen3-14B-Q3_K_M.gguf',
      sha256: '9694f1db203d5a18bea6f19a36be01b2d2c79bf9b7f8df553a4cc5cff870b47e',
      sizeBytes: 7321313664,
    });
    // cjkOverlap kept in answer round A1, crossDocQuota in A2a, scopedQuotaV2 in C3; crossDocument (A2) and
    // fileScopedQuota (C1) not.
    const on = [
      'verifyCitations',
      'enumerateWhenAsked',
      'dropUnsupportedHedges',
      'cjkOverlap',
      'crossDocQuota',
      'scopedQuotaV2',
    ];
    for (const t of p.tiers) {
      expect(t.reasoningEffort).toBe('off');
      expect(t.embeddingModel).toBe('bge-m3:567m');
      expect(t.contextLength).toBe(8192);
      const switches = Object.entries(t.answer).filter(([k, v]) => typeof v === 'boolean' && k !== 'rerankerBypassCjk');
      expect(switches.filter(([, v]) => v).map(([k]) => k)).toEqual(on);
      expect(t.answer.crossDocumentParts).toEqual(['quota', 'grouped', 'verify']);
      // Indexing rounds 2026-11-01: tables kept (I1); Chinese headings (I2, A3, A3b, C2, C4) and OCR upscaling (I3) not.
      expect(t.indexing).toEqual({ structuredTables: true, cjkHeadings: false, ocrUpscale: false });
    }
  });
});

describe('validatePresets failures', () => {
  it('checks the answer block key by key, including the reranker name', () => {
    const d = base();
    const answer = d.tiers[0]!.answer as Record<string, unknown>;
    d.tiers[0]!.answer = {
      ...answer,
      rerankerModel: 'nope',
      rerankFloor: { strict: 2, balanced: 0, broad: 0 },
      extra: 1,
    };
    delete (d.tiers[1]!.answer as Record<string, unknown>).rrfK;
    expect(problemsOf(d)).toEqual([
      expect.stringMatching(/^tiers\[0\]\.answer\.rerankerModel must be one of none, Xenova\/ms-marco-MiniLM-L-6-v2, /),
      'tiers[0].answer.rerankFloor.strict must be a number from 0 to 1',
      'tiers[0].answer.extra is not a known field',
      'tiers[1].answer.rrfK is missing',
    ]);
  });

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
      'tiers[0].embeddingModel must be an Ollama model tag such as qwen3:8b or hf.co/<user>/<repository>:<quant>',
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

  it('checks the pinned file and that its chat model comes from its repository', () => {
    const d = base();
    const file = d.tiers[1]!.chatModelFile as Record<string, unknown>;
    d.tiers[1]!.chatModelFile = { ...file, sha256: 'abc', extra: 1 };
    d.tiers[2]!.chatModelFile = file;
    d.tiers[0]!.chatModel = 'hf.co/unsloth/Qwen3-14B-GGUF';
    expect(problemsOf(d)).toEqual([
      'tiers[1].chatModelFile.sha256 must be 64 hex digits',
      'tiers[2].chatModelFile needs chatModel hf.co/<its repository>:<quant>',
    ]);
    d.tiers[1]!.chatModelFile = { ...file, extra: 1 };
    d.tiers[2]!.chatModelFile = undefined;
    delete d.tiers[2]!.chatModelFile;
    expect(problemsOf(d)).toEqual(['tiers[1].chatModelFile.extra is not a known field']);
  });

  it('caps the chunk maximum below the embedding truncation limit', () => {
    const d = base();
    d.tiers[0]!.chunkMaxChars = 3000;
    expect(problemsOf(d)).toEqual(['tiers[0].chunkMaxChars must be an integer from 200 to 2800']);
  });

  it('rejects values that would break the .env file', () => {
    const d = base();
    d.tiers[0]!.ocrLanguages = 'eng#x';
    d.tiers[2]!.chatModel = 'qwen3:8b"';
    expect(problemsOf(d)).toEqual([
      'tiers[0].ocrLanguages must not contain quotes, #, \\ or control characters',
      'tiers[2].chatModel must not contain quotes, #, \\ or control characters',
    ]);
  });

  it('reports a file that is not JSON', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-presets-')), 'p.json');
    fs.writeFileSync(file, '{');
    expect(() => loadPresets(file)).toThrow(/could not be read as JSON/);
  });
});
