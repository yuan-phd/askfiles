import fs from 'node:fs';
import path from 'node:path';
import {
  applyOverrides,
  DEFAULT_PARAMS,
  isScope,
  resolveParams,
  SCOPES,
  type AnswerParams,
  type AnswerScope,
} from '../../src/main/answer/params.js';

/** Upstream's threshold choices (upstream/frontend/src/pages/WorkspaceSettings/VectorDatabase/DocumentSimilarityThreshold). */
export const THRESHOLDS: Record<string, number> = { none: 0, low: 0.25, medium: 0.5, high: 0.75 };

export interface EvalConfig {
  /** Short name used in the run folder name and the Markdown table. */
  label: string;
  /** Server to test. Empty: the harness starts its own Ollama, collector and server (managed mode). */
  baseUrl: string;
  /** API key for baseUrl; created through /api/system/generate-api-key when empty. */
  apiKey: string;
  /** STORAGE_DIR of the server at baseUrl; the section documents are written there. External mode only. */
  storageDir: string;
  /** Managed mode: data directory kept between runs so embeddings are reused. */
  dataDir: string;
  /** Managed mode: ollama binary; empty means ollama on PATH. */
  ollamaBin: string;
  /** Managed mode: OLLAMA_MODEL_TOKEN_LIMIT, the chat context window; 0 keeps upstream's default. */
  contextTokens: number;
  /** Base name of the hidden workspace; the harness appends a hash of the embedding model. */
  workspace: string;
  chatModel: string;
  embeddingModel: string;
  similarityThreshold: number;
  topN: number;
  chunkStrategy: 'heading';
  chunkMax: number;
  chatMode: 'query' | 'chat';
  systemPrompt: string;
  temperature: number;
  /** Upstream vectorSearchMode rerank; downloads the reranker from huggingface.co on first use. */
  rerank: boolean;
  /** Sent with every chat (patches/007); empty uses the server's DEFAULT_REASONING_EFFORT. */
  reasoningEffort: string;
  passes: number;
  /** Answer pipeline values, the answer block of config/presets.json (src/main/answer/params.ts). */
  answer: AnswerParams;
  /** Answer scope whose section count and rerank floor a run uses. */
  scope: AnswerScope;
  /** Where the reranker files are, or are fetched to; empty means <dataDir>/models/reranker. */
  rerankerDir: string;
}

const DEFAULTS: Omit<EvalConfig, 'label' | 'chatModel' | 'embeddingModel'> = {
  baseUrl: '',
  apiKey: '',
  storageDir: '',
  dataDir: '',
  ollamaBin: '',
  contextTokens: 0,
  workspace: 'askfiles-eval',
  similarityThreshold: THRESHOLDS.medium!,
  topN: 4,
  chunkStrategy: 'heading',
  chunkMax: 2000,
  chatMode: 'query',
  systemPrompt: '',
  temperature: 0.1,
  rerank: false,
  reasoningEffort: 'off',
  passes: 2,
  answer: DEFAULT_PARAMS,
  scope: 'balanced',
  rerankerDir: '',
};

/**
 * Validates a parsed config and fills defaults. Relative paths resolve against baseDir (the
 * config file's folder). Throws one error listing every problem.
 */
export function resolveConfig(raw: Record<string, unknown>, baseDir: string, repoRoot: string): EvalConfig {
  const known = new Set([...Object.keys(DEFAULTS), 'label', 'chatModel', 'embeddingModel', '$comment']);
  const problems = Object.keys(raw)
    .filter((k) => !known.has(k))
    .map((k) => `unknown key ${k}`);
  const c = { ...DEFAULTS, ...raw } as Record<string, unknown>;
  if (typeof c.similarityThreshold === 'string') {
    const t = THRESHOLDS[c.similarityThreshold.toLowerCase()];
    if (t === undefined)
      problems.push(`similarityThreshold must be a number or one of ${Object.keys(THRESHOLDS).join(', ')}`);
    else c.similarityThreshold = t;
  }
  const str = (k: string, required = false) => {
    if (typeof c[k] !== 'string') problems.push(`${k} must be a string`);
    else if (required && !(c[k] as string).trim()) problems.push(`${k} is required`);
  };
  const num = (k: string, ok: (n: number) => boolean, rule: string) => {
    if (typeof c[k] !== 'number' || !ok(c[k] as number)) problems.push(`${k} must be ${rule}`);
  };
  // The prompt is always written to the workspace, so a prompt from an earlier run never lingers.
  for (const k of ['label', 'chatModel', 'embeddingModel', 'workspace', 'systemPrompt']) str(k, true);
  for (const k of ['baseUrl', 'apiKey', 'storageDir', 'dataDir', 'ollamaBin', 'reasoningEffort']) str(k);
  num('similarityThreshold', (n) => n >= 0 && n <= 1, 'between 0 and 1');
  num('topN', (n) => Number.isInteger(n) && n >= 1, 'an integer of at least 1');
  num('chunkMax', (n) => Number.isInteger(n) && n >= 400, 'an integer of at least 400');
  num('temperature', (n) => n >= 0, '0 or more');
  num('passes', (n) => Number.isInteger(n) && n >= 1, 'an integer of at least 1');
  num('contextTokens', (n) => Number.isInteger(n) && n >= 0, 'an integer, 0 for the default');
  if (c.chunkStrategy !== 'heading') problems.push('chunkStrategy must be heading');
  if (c.chatMode !== 'query' && c.chatMode !== 'chat') problems.push('chatMode must be query or chat');
  if (!isScope(c.scope)) problems.push(`scope must be one of ${SCOPES.join(', ')}`);
  str('rerankerDir');
  try {
    // The block may name only the values it changes; the rest are the defaults.
    c.answer = resolveParams(raw.answer as Record<string, unknown> | undefined);
  } catch (e) {
    problems.push(...(e as Error).message.split('; '));
  }
  if (typeof c.rerank !== 'boolean') problems.push('rerank must be true or false');
  if (typeof c.baseUrl === 'string' && c.baseUrl && !c.storageDir) {
    problems.push('storageDir is required with baseUrl: the harness writes section documents into it');
  }
  if (problems.length) throw new Error(`config:\n  ${problems.join('\n  ')}`);
  const abs = (p: string) => (p ? path.resolve(baseDir, p) : p);
  const config = c as unknown as EvalConfig & { $comment?: unknown };
  delete config.$comment;
  config.baseUrl = config.baseUrl.replace(/\/+$/, '');
  config.storageDir = abs(config.storageDir);
  config.dataDir = config.dataDir ? abs(config.dataDir) : path.join(repoRoot, '.eval-data');
  config.ollamaBin = config.ollamaBin && config.ollamaBin.includes('/') ? abs(config.ollamaBin) : config.ollamaBin;
  config.rerankerDir = config.rerankerDir ? abs(config.rerankerDir) : path.join(config.dataDir, 'models', 'reranker');
  return config;
}

/**
 * Applies --set name=value overrides: answer parameters by their names (rerankFloor=0.35,
 * sectionCount.balanced=4, see applyOverrides), any other config key at the top level
 * (temperature=0, scope=strict, chatModel=qwen3:4b). Values parse as JSON when they can.
 */
export function applySets(config: EvalConfig, sets: string[]): EvalConfig {
  const answerSets: string[] = [];
  const top: Record<string, unknown> = {};
  for (const set of sets) {
    const eq = set.indexOf('=');
    const name = eq > 0 ? set.slice(0, eq).trim().split('.')[0]! : '';
    if (name in DEFAULT_PARAMS) {
      answerSets.push(set);
      continue;
    }
    if (eq < 1 || !(name in DEFAULTS || ['label', 'chatModel', 'embeddingModel'].includes(name)) || name === 'answer') {
      throw new Error(`--set ${set}: unknown parameter`);
    }
    const raw = set.slice(eq + 1).trim();
    try {
      top[name] = JSON.parse(raw);
    } catch {
      top[name] = raw;
    }
  }
  const answer = applyOverrides(config.answer, answerSets);
  const next = { ...config, ...top, answer };
  const problems: string[] = [];
  if (!isScope(next.scope)) problems.push(`scope must be one of ${SCOPES.join(', ')}`);
  for (const k of Object.keys(top)) {
    if (typeof top[k] !== typeof (config as unknown as Record<string, unknown>)[k]) {
      problems.push(`${k} must be a ${typeof (config as unknown as Record<string, unknown>)[k]}`);
    }
  }
  if (problems.length) throw new Error(`--set: ${problems.join('; ')}`);
  return next;
}

export function loadConfig(file: string, repoRoot: string): EvalConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  return resolveConfig(raw, path.dirname(path.resolve(file)), repoRoot);
}

/** The config as recorded in run.json: the API key is never written to disk. */
export function redact(config: EvalConfig): EvalConfig {
  return { ...config, apiKey: config.apiKey ? '(set)' : '' };
}
