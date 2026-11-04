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

/** complete: name every condition, exception, step and figure, in the sources' own words (round 5). */
export const PROMPT_VARIANTS = ['default', 'strict', 'complete'] as const;

/**
 * single: one model call over the selected sections. quoted: an extraction call returns verbatim
 * excerpts from the top extractSections sections, code keeps only those found in the section text,
 * and a composition call answers from the verified excerpts alone (src/main/answer/quoted.ts).
 */
export const ANSWER_MODES = ['single', 'quoted'] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];
export type PromptVariant = (typeof PROMPT_VARIANTS)[number];

export type PerScope<T> = Record<AnswerScope, T>;

/**
 * The three parts of crossDocument, each of which can be left out for a measurement: quota
 * retrieval, the prompt grouped by file, and verification by the file a sentence names.
 */
export const CROSS_DOCUMENT_PARTS = ['quota', 'grouped', 'verify'] as const;
export type CrossDocumentPart = (typeof CROSS_DOCUMENT_PARTS)[number];

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
  /**
   * A question that names a file (its name, title or a type word only it has) raises the fused
   * score of that file's sections; when it names exactly one, citations may move only to its
   * sections; when it names two or more, AFFINITY_MULTI_SECTIONS sections are selected instead of
   * the scope's count. Sources in the prompt then carry file name and type (docs/plan.md round 7).
   */
  documentAffinity: boolean;
  /** A question asking for a set (three factors, list the steps) is told to give every item (round 8). */
  enumerateWhenAsked: boolean;
  /**
   * With enumerateWhenAsked: when the question states a count and the answer lists fewer items,
   * one follow-up call with the same sources asks for the missing ones.
   */
  enumerateFollowUp: boolean;
  /**
   * One rule on every question in place of the enumerateWhenAsked set rule: do not summarize,
   * merge or group, state each listed item separately with its citation (docs/plan.md round 9).
   */
  noSummarizing: boolean;
  /**
   * Split a question on its explicit structure only (asks joined by and, as well as or a comma
   * list, or Compare A and B), answer each part with the full pipeline, merge (decompose.ts).
   */
  decomposeQuestions: boolean;
  /**
   * After verifyCitations: delete an unsupported sentence that only says information is missing
   * (not specified, not stated) when the answer has a supported sentence (hedges.ts).
   */
  dropUnsupportedHedges: boolean;
  /**
   * verifyCitations measures a mainly Chinese, Japanese or Korean sentence by character pairs
   * against the source and with its own threshold (VERIFY_MIN_OVERLAP_CJK); other sentences keep
   * content words and 0.5 (docs/plan.md, round A1).
   */
  cjkOverlap: boolean;
  /**
   * Questions that name two or more files (file identifiers, browse/identifiers.ts): each named
   * file's top sections join the selection, the prompt groups the sources by file and asks for one
   * part per file before the comparison, and a sentence naming a file may cite only that file's
   * sources (docs/plan.md, round A2). A question naming one file is unchanged.
   */
  crossDocument: boolean;
  /** The parts crossDocument applies; all three by default. */
  crossDocumentParts: CrossDocumentPart[];
  /**
   * crossDocument's quota part alone (docs/plan.md, round A2a): a question naming two or more
   * files gets each named file's top sections of the fused list in its selection; prompt and
   * verification unchanged.
   */
  crossDocQuota: boolean;
  /**
   * With the quota part: a named file's quota sections come from retrieval inside that file
   * (vector search and keyword search restricted to its sections, fused by RRF, top
   * CROSS_DOCUMENT_QUOTA) instead of from its best sections in the library-wide fused list
   * (docs/plan.md, round C1).
   */
  fileScopedQuota: boolean;
  /**
   * fileScopedQuota's search inside each named file with three changes (docs/plan.md, round C3):
   * table-of-contents sections are no candidates inside the file (neither list), the quota is
   * SCOPED_V2_QUOTA sections per file, and a question naming two or more files gets at most
   * SCOPED_V2_MAX_SECTIONS sections in all, the files' quota sections taken in turn.
   */
  scopedQuotaV2: boolean;
  /**
   * The keyword index and the question's keyword terms match English words by their Porter stem
   * (planning and Plan both procur plan), as whole words; Chinese terms unchanged (browse/stem.ts,
   * docs/plan.md round S1).
   */
  keywordStemming: boolean;
  /**
   * With the in-file search of fileScopedQuota or scopedQuotaV2: each named file is searched
   * inside with the clause of the question that names it alone (subquery.ts), the whole question
   * when there is none; selection, the prompt and verification unchanged (docs/plan.md, round X1).
   */
  perFileSubquery: boolean;
}

/** The crossDocument parts in effect: crossDocument's own, or the quota alone with crossDocQuota. */
export function crossDocumentPartsOf(
  p: Pick<AnswerParams, 'crossDocument' | 'crossDocumentParts' | 'crossDocQuota'>,
): Set<CrossDocumentPart> {
  if (p.crossDocument) return new Set(p.crossDocumentParts);
  return new Set(p.crossDocQuota ? ['quota'] : []);
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
  documentAffinity: false,
  enumerateWhenAsked: false,
  enumerateFollowUp: false,
  noSummarizing: false,
  decomposeQuestions: false,
  dropUnsupportedHedges: false,
  cjkOverlap: false,
  crossDocument: false,
  crossDocumentParts: [...CROSS_DOCUMENT_PARTS],
  crossDocQuota: false,
  fileScopedQuota: false,
  scopedQuotaV2: false,
  keywordStemming: false,
  perFileSubquery: false,
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
    (PROMPT_VARIANTS as readonly unknown[]).includes(v) ? null : `must be one of ${PROMPT_VARIANTS.join(', ')}`,
  answerMode: (v) => ((ANSWER_MODES as readonly unknown[]).includes(v) ? null : `must be ${ANSWER_MODES.join(' or ')}`),
  extractSections: intAtLeast(1),
  verifyCitations: bool,
  paragraphSelection: bool,
  verdictLine: bool,
  documentAffinity: bool,
  enumerateWhenAsked: bool,
  enumerateFollowUp: bool,
  noSummarizing: bool,
  decomposeQuestions: bool,
  dropUnsupportedHedges: bool,
  cjkOverlap: bool,
  crossDocument: bool,
  crossDocumentParts: (v) =>
    Array.isArray(v) && v.every((x) => (CROSS_DOCUMENT_PARTS as readonly unknown[]).includes(x))
      ? null
      : `must be a list of ${CROSS_DOCUMENT_PARTS.join(', ')}`,
  crossDocQuota: bool,
  fileScopedQuota: bool,
  scopedQuotaV2: bool,
  keywordStemming: bool,
  perFileSubquery: bool,
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
    const isPerScope = cur !== null && typeof cur === 'object' && !Array.isArray(cur);
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
