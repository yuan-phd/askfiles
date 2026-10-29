import fs from 'node:fs';
import path from 'node:path';

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
  return config;
}

export function loadConfig(file: string, repoRoot: string): EvalConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  return resolveConfig(raw, path.dirname(path.resolve(file)), repoRoot);
}

/** The config as recorded in run.json: the API key is never written to disk. */
export function redact(config: EvalConfig): EvalConfig {
  return { ...config, apiKey: config.apiKey ? '(set)' : '' };
}
