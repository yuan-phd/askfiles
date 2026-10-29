import fs from 'node:fs';
import path from 'node:path';
import { randomSecret, renderServerEnv } from '../process-manager/env-file.js';
import type { Preset } from './schema.js';

export type EnvEntry = readonly [key: string, value: string];

/**
 * Keys the preset needs that upstream dumpENV does not keep: it rewrites the .env file from an allow
 * list (upstream/server/utils/helpers/updateENV.js, dumpENV) on any settings change. Patch 007 adds
 * DEFAULT_REASONING_EFFORT without adding it to that list, so the shell must also pass these in the
 * server's spawn environment at every start (presetSpawnEnv).
 */
export const NOT_KEPT_BY_DUMPENV = ['DEFAULT_REASONING_EFFORT'] as const;

/**
 * The server .env lines for a preset, in file order. Names are from docs/upstream-analysis.md Q7.
 * The two Ollama URLs record the first run like the ports do: the process manager passes the
 * current URL at every start and the spawn environment wins over the file.
 */
export function presetEnv(preset: Preset, o: { ollamaBaseUrl: string }): EnvEntry[] {
  const ollama = o.ollamaBaseUrl.replace(/\/+$/, '');
  return [
    ['LLM_PROVIDER', 'ollama'],
    ['OLLAMA_BASE_PATH', ollama],
    ['OLLAMA_MODEL_PREF', preset.chatModel],
    ['OLLAMA_MODEL_TOKEN_LIMIT', String(preset.contextLength)],
    ['EMBEDDING_ENGINE', 'ollama'],
    ['EMBEDDING_BASE_PATH', ollama],
    ['EMBEDDING_MODEL_PREF', preset.embeddingModel],
    // Upstream's chunk size defaults to this limit, so a section up to chunkMaxChars stays one chunk.
    ['EMBEDDING_MODEL_MAX_CHUNK_LENGTH', String(preset.chunkMaxChars)],
    ['VECTOR_DB', 'lancedb'],
    ['DISABLE_TELEMETRY', 'true'],
    ['TARGET_OCR_LANG', preset.ocrLanguages],
    ['DEFAULT_REASONING_EFFORT', preset.reasoningEffort],
  ];
}

/** Variables to put in the server's spawn environment at every start; see NOT_KEPT_BY_DUMPENV. */
export function presetSpawnEnv(preset: Preset): Record<string, string> {
  const keep = new Set<string>(NOT_KEPT_BY_DUMPENV);
  return Object.fromEntries(presetEnv(preset, { ollamaBaseUrl: 'unused' }).filter(([k]) => keep.has(k)));
}

/**
 * Library workspace columns that no environment variable sets (docs/upstream-analysis.md, Workspace
 * settings). Body for POST /api/v1/workspace/new or /api/v1/workspace/{slug}/update.
 */
export function workspaceSettings(preset: Preset): Record<string, string | number> {
  return {
    chatMode: preset.chatMode,
    similarityThreshold: preset.similarityThreshold,
    topN: preset.maxSnippets,
    openAiTemp: preset.temperature,
    openAiPrompt: preset.systemPrompt,
  };
}

export function presetHeader(preset: Preset): string {
  return `# Preset ${preset.id} (${preset.label}): starting values, phase 2 replaces them.`;
}

function formatLine([key, value]: EnvEntry): string {
  if (/[\n\r"\\]/.test(value)) throw new Error(`env value for ${key} contains a quote, backslash or newline`);
  return `${key}="${value}"`;
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Sets each entry in an existing .env text. A key already present is replaced in place (later
 * duplicates are dropped so no older value can win); missing keys are appended after header.
 * Every other line, secrets included, is kept as it is.
 */
export function mergeEnvText(text: string, entries: readonly EnvEntry[], header?: string): string {
  const wanted = new Map(entries.map(([k, v]) => [k, v]));
  const done = new Set<string>();
  const out: string[] = [];
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  for (const line of lines) {
    const key = KEY_LINE.exec(line)?.[1];
    if (key === undefined || !wanted.has(key)) {
      out.push(line);
    } else if (!done.has(key)) {
      out.push(formatLine([key, wanted.get(key)!]));
      done.add(key);
    }
  }
  const rest = entries.filter(([k]) => !done.has(k));
  if (rest.length > 0) {
    if (header) out.push(header);
    for (const e of rest) out.push(formatLine(e));
  }
  return out.length === 0 ? '' : out.join('\n') + '\n';
}

/**
 * Writes entries into the server .env. A missing file is created with fresh secrets first, the same
 * way the process manager would, so the result never lacks JWT_SECRET, SIG_KEY or SIG_SALT. The
 * write goes through a temporary file and a rename so a crash never leaves half a file.
 */
export function writeServerEnv(
  file: string,
  entries: readonly EnvEntry[],
  o: { header?: string; secret?: () => string } = {},
): string {
  let current: string;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    current = renderServerEnv({}, o.secret ?? randomSecret);
  }
  const next = mergeEnvText(current, entries, o.header);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}
