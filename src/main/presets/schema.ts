import fs from 'node:fs';
import { answerParamProblems, type AnswerParams } from '../answer/params.js';

export interface Preset {
  id: string;
  label: string;
  /** Lowest total RAM, in GiB, that gets this tier. */
  minRamGb: number;
  /** Where the values come from: the phase 2 measurements (docs/plan.md, v1 result). */
  comment: string;
  /** Null turns Ask off on this tier: no chat model is pulled, Browse and Find stay. */
  chatModel: string | null;
  /**
   * A chat model pulled from Hugging Face, pinned: Ollama pulls hf.co/<repository>:<quant> and
   * cannot pick a revision, so the pulled weights must have this sha256 (the file's at revision)
   * or the model is refused (src/main/models/pinned.ts).
   */
  chatModelFile?: ChatModelFile;
  embeddingModel: string;
  /** OLLAMA_MODEL_TOKEN_LIMIT, sent to Ollama as num_ctx on every chat call. */
  contextLength: number;
  /** Largest section chunk in characters; also EMBEDDING_MODEL_MAX_CHUNK_LENGTH. */
  chunkMaxChars: number;
  maxSnippets: number;
  similarityThreshold: number;
  chatMode: 'query';
  temperature: number;
  reasoningEffort: 'off';
  ocrLanguages: string;
  systemPrompt: string;
  /** Answer pipeline values (src/main/answer/params.ts); the reranker is fetched at first run. */
  answer: AnswerParams;
}

export interface ChatModelFile {
  repository: string;
  /** The commit the file was measured at. */
  revision: string;
  file: string;
  sha256: string;
  sizeBytes: number;
}

export interface PresetFile {
  version: 1;
  comment: string;
  tiers: Preset[];
}

export class PresetError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid presets: ${problems.join('; ')}`);
    this.name = 'PresetError';
  }
}

// Ollama model names: optional namespace, name, optional tag; or hf.co/<user>/<repository>:<quant>.
const MODEL_TAG = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const HF_TAG = /^hf\.co\/([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const OCR_LANGS = /^[a-z_]+(,[a-z_]+)*$/;
// dumpENV cuts a value at the first of these (upstream/server/utils/helpers/updateENV.js, sanitizeValue),
// and a quote or newline would also break our own KEY="value" lines.
const UNSAFE_ENV_VALUE = /[\n\r\t\v\f"'`#\\]/;

// Upstream measures chunks in characters; Ollama silently truncates embedding input at 2048 tokens,
// which bge-m3 reaches at about 3000 Chinese characters (docs/upstream-analysis.md Q10).
export const MAX_CHUNK_CHARS = 2800;

type Check = (v: unknown) => string | null;

const str: Check = (v) => (typeof v === 'string' && v.trim() !== '' ? null : 'must be a non-empty string');
const envStr: Check = (v) =>
  str(v) ?? (UNSAFE_ENV_VALUE.test(v as string) ? 'must not contain quotes, #, \\ or control characters' : null);
const tag: Check = (v) =>
  envStr(v) ??
  (MODEL_TAG.test(v as string) || HF_TAG.test(v as string)
    ? null
    : 'must be an Ollama model tag such as qwen3:8b or hf.co/<user>/<repository>:<quant>');
const int =
  (min: number, max: number): Check =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max
      ? null
      : `must be an integer from ${min} to ${max}`;
const num =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
      ? null
      : `must be a number from ${min} to ${max}`;
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    values.includes(v as string) ? null : `must be ${values.map((x) => JSON.stringify(x)).join(' or ')}`;

const fileProblems = (v: unknown, chatModel: unknown): string | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
  const f = v as Record<string, unknown>;
  for (const k of ['repository', 'revision', 'file']) if (str(f[k])) return `.${k} must be a non-empty string`;
  if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return '.sha256 must be 64 hex digits';
  if (!Number.isInteger(f.sizeBytes) || (f.sizeBytes as number) <= 0) return '.sizeBytes must be a positive integer';
  const extra = Object.keys(f).filter((k) => !['repository', 'revision', 'file', 'sha256', 'sizeBytes'].includes(k));
  if (extra.length) return `.${extra[0]} is not a known field`;
  const m = typeof chatModel === 'string' ? HF_TAG.exec(chatModel) : null;
  if (!m || m[1] !== f.repository) return 'needs chatModel hf.co/<its repository>:<quant>';
  return null;
};

type RequiredField = Exclude<keyof Preset, 'chatModelFile'>;

const PRESET_FIELDS: Record<RequiredField, Check> = {
  id: (v) => str(v) ?? (/^[a-z0-9-]+$/.test(v as string) ? null : 'must use a-z, 0-9 and -'),
  label: str,
  minRamGb: num(0, 4096),
  comment: str,
  chatModel: (v) => (v === null ? null : tag(v)),
  embeddingModel: tag,
  contextLength: int(2048, 131072),
  chunkMaxChars: int(200, MAX_CHUNK_CHARS),
  maxSnippets: int(1, 32),
  similarityThreshold: num(0, 1),
  // The plan fixes query mode and thinking off for every tier.
  chatMode: oneOf('query'),
  temperature: num(0, 2),
  reasoningEffort: oneOf('off'),
  ocrLanguages: (v) => envStr(v) ?? (OCR_LANGS.test(v as string) ? null : 'must be comma separated tesseract codes'),
  systemPrompt: str,
  // Checked in full below, with one problem per bad key.
  answer: () => null,
};

/** Returns the presets typed, or throws PresetError listing every problem found. */
export function validatePresets(data: unknown): PresetFile {
  const problems: string[] = [];
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new PresetError(['top level must be an object']);
  const d = data as Record<string, unknown>;
  if (d.version !== 1) problems.push('version must be 1');
  if (str(d.comment)) problems.push('comment must be a non-empty string');
  if (!Array.isArray(d.tiers) || d.tiers.length === 0) {
    problems.push('tiers must be a non-empty array');
    throw new PresetError(problems);
  }

  const ids = new Set<string>();
  let lastMin = -Infinity;
  d.tiers.forEach((t: unknown, i: number) => {
    const at = `tiers[${i}]`;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const tier = t as Record<string, unknown>;
    for (const [key, check] of Object.entries(PRESET_FIELDS)) {
      const problem = key in tier ? check(tier[key]) : 'is missing';
      if (problem) problems.push(`${at}.${key} ${problem}`);
    }
    for (const key of Object.keys(tier)) {
      if (!(key in PRESET_FIELDS) && key !== 'chatModelFile') problems.push(`${at}.${key} is not a known field`);
    }
    if ('chatModelFile' in tier) {
      const p = fileProblems(tier.chatModelFile, tier.chatModel);
      if (p) problems.push(`${at}.chatModelFile${p.startsWith('.') ? '' : ' '}${p}`);
    }
    if ('answer' in tier) problems.push(...answerParamProblems(tier.answer, `${at}.answer`));
    if (typeof tier.id === 'string') {
      if (ids.has(tier.id)) problems.push(`${at}.id ${tier.id} is used twice`);
      ids.add(tier.id);
    }
    if (typeof tier.minRamGb === 'number') {
      if (tier.minRamGb <= lastMin) problems.push(`${at}.minRamGb must be greater than the tier before it`);
      lastMin = tier.minRamGb;
    }
  });

  if (problems.length > 0) throw new PresetError(problems);
  return data as PresetFile;
}

export function loadPresets(file: string): PresetFile {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new PresetError([`${file} could not be read as JSON: ${(e as Error).message}`]);
  }
  return validatePresets(data);
}
