/**
 * Every tunable value of the answer pipeline. The same names are used in the answer block of
 * config/presets.json and of scripts/eval/configs/*.json, so a value found by the eval is copied
 * into the preset unchanged. docs/eval.md lists each one with its default and its effect.
 */
import { RERANKER_MODELS } from './reranker-models.js';

export const SCOPES = ['strict', 'balanced', 'broad'] as const;
export type AnswerScope = (typeof SCOPES)[number];

export const PROMPT_VARIANTS = ['default', 'strict'] as const;
export type PromptVariant = (typeof PROMPT_VARIANTS)[number];

export type PerScope<T> = Record<AnswerScope, T>;

export interface AnswerParams {
  /** Hugging Face repository of the cross-encoder, stored under <dataDir>/models/reranker. */
  rerankerModel: string;
  /**
   * Skip reranking for a question when it or any candidate section is mainly Chinese, Japanese or
   * Korean; for an English-only reranker, which scores such text near zero.
   */
  rerankerBypassCjk: boolean;
  /** Sub-chunks asked from the vector search, with no score floor. */
  vectorTopK: number;
  /** Sections asked from the keyword index. */
  keywordTopK: number;
  /** k of reciprocal rank fusion: 1 / (k + rank). */
  rrfK: number;
  /** Sections passed to the reranker after fusion; bounds rerank time. */
  candidateSections: number;
  /** Longest section text in characters; 0 means twice the chunk maximum. */
  sectionCapChars: number;
  /** Most sections given to the model, per answer scope. */
  sectionCount: PerScope<number>;
  /** Lowest rerank score a section needs, per answer scope. */
  rerankFloor: PerScope<number>;
  /** Tokens for the numbered sources; 0 derives it from the context length. */
  contextBudgetTokens: number;
  promptVariant: PromptVariant;
}

export const DEFAULT_PARAMS: AnswerParams = {
  rerankerModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
  rerankerBypassCjk: true,
  vectorTopK: 30,
  keywordTopK: 30,
  rrfK: 60,
  candidateSections: 12,
  sectionCapChars: 0,
  sectionCount: { strict: 2, balanced: 3, broad: 5 },
  rerankFloor: { strict: 0.5, balanced: 0.1, broad: 0.01 },
  contextBudgetTokens: 0,
  promptVariant: 'default',
};

/** Tokens kept free for the answer itself and for the instructions and the question. */
export const ANSWER_RESERVE_TOKENS = 1024;
export const PROMPT_RESERVE_TOKENS = 512;
/** The smallest source budget, whatever the context length. */
export const MIN_BUDGET_TOKENS = 600;

export function contextBudget(params: AnswerParams, contextLength: number): number {
  if (params.contextBudgetTokens > 0) return params.contextBudgetTokens;
  return Math.max(MIN_BUDGET_TOKENS, contextLength - ANSWER_RESERVE_TOKENS - PROMPT_RESERVE_TOKENS);
}

export function sectionCap(params: AnswerParams, chunkMaxChars: number): number {
  return params.sectionCapChars > 0 ? params.sectionCapChars : chunkMaxChars * 2;
}

export function isScope(v: unknown): v is AnswerScope {
  return (SCOPES as readonly unknown[]).includes(v);
}

type Problem = string | null;
const intAtLeast =
  (min: number) =>
  (v: unknown): Problem =>
    Number.isInteger(v) && (v as number) >= min ? null : `must be an integer of at least ${min}`;
const numIn =
  (min: number, max: number) =>
  (v: unknown): Problem =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
      ? null
      : `must be a number from ${min} to ${max}`;
const perScope =
  (check: (v: unknown) => Problem) =>
  (v: unknown): Problem => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object with strict, balanced and broad';
    const o = v as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !isScope(k));
    if (extra.length) return `has unknown key ${extra[0]}`;
    for (const s of SCOPES) {
      const p = s in o ? check(o[s]) : 'is missing';
      if (p) return `.${s} ${p}`;
    }
    return null;
  };

const CHECKS: Record<keyof AnswerParams, (v: unknown) => Problem> = {
  rerankerModel: (v) =>
    typeof v === 'string' && v in RERANKER_MODELS ? null : `must be one of ${Object.keys(RERANKER_MODELS).join(', ')}`,
  rerankerBypassCjk: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  vectorTopK: intAtLeast(1),
  keywordTopK: intAtLeast(0),
  rrfK: intAtLeast(1),
  candidateSections: intAtLeast(1),
  sectionCapChars: intAtLeast(0),
  sectionCount: perScope(intAtLeast(1)),
  rerankFloor: perScope(numIn(0, 1)),
  contextBudgetTokens: intAtLeast(0),
  promptVariant: (v) =>
    (PROMPT_VARIANTS as readonly unknown[]).includes(v) ? null : `must be ${PROMPT_VARIANTS.join(' or ')}`,
};

/** Problems with an answer block, each prefixed with at; every key is required. */
export function answerParamProblems(v: unknown, at: string): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${at} must be an object`];
  const o = v as Record<string, unknown>;
  const problems: string[] = [];
  for (const [key, check] of Object.entries(CHECKS)) {
    const p = key in o ? check(o[key]) : 'is missing';
    if (p) problems.push(`${at}.${key}${p.startsWith('.') ? '' : ' '}${p}`);
  }
  for (const key of Object.keys(o)) if (!(key in CHECKS)) problems.push(`${at}.${key} is not a known field`);
  return problems;
}

/** A partial answer block over the defaults; throws listing every problem. */
export function resolveParams(
  partial: Record<string, unknown> | undefined,
  base: AnswerParams = DEFAULT_PARAMS,
): AnswerParams {
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(partial ?? {})) {
    const cur = merged[k];
    merged[k] =
      cur && typeof cur === 'object' && v && typeof v === 'object' && !Array.isArray(v) ? { ...cur, ...v } : v;
  }
  const problems = answerParamProblems(merged, 'answer');
  if (problems.length) throw new Error(problems.join('; '));
  return merged as unknown as AnswerParams;
}

/**
 * Applies name=value overrides such as rerankFloor=0.35, rerankFloor.balanced=0.35 or
 * sectionCount.strict=1. A per-scope name without a scope sets all three. Values are JSON when
 * they parse as JSON (numbers, true, false), else strings.
 */
export function applyOverrides(params: AnswerParams, sets: string[]): AnswerParams {
  const out = structuredClone(params) as unknown as Record<string, unknown>;
  for (const set of sets) {
    const eq = set.indexOf('=');
    if (eq < 1) throw new Error(`--set ${set}: expected name=value`);
    const [name, scope, ...rest] = set.slice(0, eq).trim().split('.');
    const raw = set.slice(eq + 1).trim();
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // A plain string such as a model name.
    }
    if (!name || rest.length || !(name in CHECKS))
      throw new Error(`--set ${set}: unknown parameter ${set.slice(0, eq)}`);
    const cur = out[name];
    const isPerScope = cur !== null && typeof cur === 'object';
    if (scope !== undefined) {
      if (!isPerScope || !isScope(scope)) throw new Error(`--set ${set}: ${name} has no part ${scope}`);
      (cur as Record<string, unknown>)[scope] = value;
    } else if (isPerScope && (typeof value !== 'object' || value === null)) {
      for (const s of SCOPES) (cur as Record<string, unknown>)[s] = value;
    } else {
      out[name] = value;
    }
  }
  return resolveParams(out);
}

/** The values one question runs with: the scope picked out of the per-scope ones. */
export interface RunSettings {
  params: AnswerParams;
  scope: AnswerScope;
  chatModel: string;
  contextLength: number;
  chunkMaxChars: number;
  temperature: number;
}
