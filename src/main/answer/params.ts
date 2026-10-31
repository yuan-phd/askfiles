/**
 * Every tunable value of the answer pipeline. The same names are used in the answer block of
 * config/presets.json and of scripts/eval/configs/*.json, so a value found by the eval is copied
 * into the preset unchanged. docs/eval.md lists each one with its default and its effect.
 */
import { RERANKER_MODELS } from './reranker-models.js';

/** rerankerModel value that turns the cross-encoder off: fused order, vectorFloor instead of rerankFloor. */
export const NO_RERANKER = 'none';

export const SCOPES = ['strict', 'balanced', 'broad'] as const;
export type AnswerScope = (typeof SCOPES)[number];

export const PROMPT_VARIANTS = ['default', 'strict'] as const;

/**
 * single: one model call over the selected sections. quoted: an extraction call returns verbatim
 * excerpts from the top extractSections sections, code keeps only those found in the section text,
 * and a composition call answers from the verified excerpts alone (src/main/answer/quoted.ts).
 */
export const ANSWER_MODES = ['single', 'quoted'] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];
export type PromptVariant = (typeof PROMPT_VARIANTS)[number];

export type PerScope<T> = Record<AnswerScope, T>;

export interface AnswerParams {
  /**
   * Hugging Face repository of the cross-encoder, stored under <dataDir>/models/reranker, or none:
   * sections are then taken in fused order and vectorFloor replaces rerankFloor.
   */
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
  /**
   * With rerankerModel none: lowest vector similarity a section's best sub-chunk needs, per answer
   * scope. A section found by the keyword index alone has none and passes only a floor of 0.
   */
  vectorFloor: PerScope<number>;
  /** Tokens for the numbered sources; 0 derives it from the context length. */
  contextBudgetTokens: number;
  promptVariant: PromptVariant;
  answerMode: AnswerMode;
  /** quoted mode: sections sent to the extraction call (N), table-of-contents sections left out. */
  extractSections: number;
  /**
   * single mode: check each sentence against the source it cites by content-word overlap, move it
   * to a better source or mark it unsupported; cards show only what stays cited (verify.ts).
   */
  verifyCitations: boolean;
  /**
   * A selected section longer than twice the chunk maximum is sent as its paragraphs closest to
   * the question by embedding similarity plus keyword hits, with one neighbour each (paragraphs.ts).
   */
  paragraphSelection: boolean;
  /** The answer starts with a line FOUND or NOT_FOUND, which code reads to decide the not-found state. */
  verdictLine: boolean;
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
  vectorFloor: { strict: 0, balanced: 0, broad: 0 },
  contextBudgetTokens: 0,
  promptVariant: 'default',
  answerMode: 'single',
  extractSections: 6,
  verifyCitations: false,
  paragraphSelection: false,
  verdictLine: false,
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

export function rerankerOff(params: Pick<AnswerParams, 'rerankerModel'>): boolean {
  return params.rerankerModel === NO_RERANKER;
}

/** The floor that decides selection: vectorFloor without a reranker, else rerankFloor. */
export function floorOf(params: AnswerParams, scope: AnswerScope): number {
  return rerankerOff(params) ? params.vectorFloor[scope] : params.rerankFloor[scope];
}

/** Sets the floor that decides selection for one scope; returns params for chaining. */
export function setFloor(params: AnswerParams, scope: AnswerScope, floor: number): AnswerParams {
  if (rerankerOff(params)) params.vectorFloor[scope] = floor;
  else params.rerankFloor[scope] = floor;
  return params;
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

const bool = (v: unknown): Problem => (typeof v === 'boolean' ? null : 'must be true or false');

const CHECKS: Record<keyof AnswerParams, (v: unknown) => Problem> = {
  rerankerModel: (v) =>
    typeof v === 'string' && (v === NO_RERANKER || v in RERANKER_MODELS)
      ? null
      : `must be one of ${[NO_RERANKER, ...Object.keys(RERANKER_MODELS)].join(', ')}`,
  rerankerBypassCjk: bool,
  vectorTopK: intAtLeast(1),
  keywordTopK: intAtLeast(0),
  rrfK: intAtLeast(1),
  candidateSections: intAtLeast(1),
  sectionCapChars: intAtLeast(0),
  sectionCount: perScope(intAtLeast(1)),
  rerankFloor: perScope(numIn(0, 1)),
  vectorFloor: perScope(numIn(0, 1)),
  contextBudgetTokens: intAtLeast(0),
  promptVariant: (v) =>
    (PROMPT_VARIANTS as readonly unknown[]).includes(v) ? null : `must be ${PROMPT_VARIANTS.join(' or ')}`,
  answerMode: (v) => ((ANSWER_MODES as readonly unknown[]).includes(v) ? null : `must be ${ANSWER_MODES.join(' or ')}`),
  extractSections: intAtLeast(1),
  verifyCitations: bool,
  paragraphSelection: bool,
  verdictLine: bool,
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
