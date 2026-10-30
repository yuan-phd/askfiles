import type { RunSettings } from './answer/index.js';
import type { EnvEntry, Preset, PresetFile } from './presets/index.js';
import {
  ANSWER_MODELS,
  ANSWER_SCOPES,
  CONTEXT_LENGTHS,
  defaultSettings,
  type AnswerModel,
  type AnswerScope,
  type Settings,
} from './shell-state.js';

/**
 * The Settings page (Session K, part 4): four controls, stored in shell.json and applied through
 * the presets code. What each one maps to:
 *
 * | Control         | Stored as                | Applied to                                                    |
 * | --------------- | ------------------------ | ------------------------------------------------------------- |
 * | Answer scope    | settings.answerScope     | RunSettings.scope of the answer pipeline (src/main/answer):     |
 * |                 |                          | section count and rerank floor per scope (presets answer.*);    |
 * |                 |                          | Balanced when unset (answerScopeOf)                             |
 * | Answer model    | settings.answerModel     | OLLAMA_MODEL_PREF in server/.env (better: this Mac's tier,     |
 * |                 |                          | faster: the tier below), model pulled first when missing       |
 * | Context length  | settings.contextLength   | OLLAMA_MODEL_TOKEN_LIMIT in server/.env, num_ctx of each chat  |
 * | Reindex         | not stored               | LibraryManager.reindex() on the current library               |
 *
 * Model and context changes restart the server, which reads the .env at start.
 */

export interface ModelChoice {
  choice: AnswerModel;
  model: string;
  /** The tier the model comes from, such as 16 GB. */
  tierLabel: string;
}

export interface SettingsView {
  values: Settings;
  /** Faster is null on a Mac in the lowest tier: there is no smaller tier to fall back to. */
  models: { faster: ModelChoice | null; better: ModelChoice };
  /** The preset's own context length, used while values.contextLength is null. */
  contextDefault: number;
  contextChoices: readonly number[];
  scopes: readonly AnswerScope[];
}

/**
 * Better is the model of this Mac's own tier; Faster the model of the next lower tier, which needs
 * less memory and answers sooner. Decided with the owner on 2026-10-30.
 */
export function modelChoices(presets: PresetFile, machine: Preset): SettingsView['models'] {
  const tiers = [...presets.tiers].sort((a, b) => a.minRamGb - b.minRamGb);
  const at = tiers.findIndex((t) => t.id === machine.id);
  const below = at > 0 ? tiers[at - 1]! : null;
  return {
    better: { choice: 'better', model: machine.chatModel, tierLabel: machine.label },
    faster:
      below && below.chatModel !== machine.chatModel
        ? { choice: 'faster', model: below.chatModel, tierLabel: below.label }
        : null,
  };
}

/**
 * The answer scope the answer pipeline runs with (src/main/answer, RunSettings.scope): the stored
 * one, or Balanced when the store holds none or a value it does not know.
 */
export function answerScopeOf(s: Partial<Settings> | null | undefined): AnswerScope {
  return s && ANSWER_SCOPES.includes(s.answerScope as AnswerScope) ? (s.answerScope as AnswerScope) : 'balanced';
}

/**
 * What the answer pipeline runs each question with: the preset's answer parameters, the stored
 * answer scope (Balanced when unset), the chat model the server .env names, and the Settings page's
 * context length. Read fresh for every question, so a change on the Settings page applies to the
 * next one without a restart.
 */
export function runSettingsFor(o: {
  presets: PresetFile;
  machine: Preset;
  settings: Partial<Settings> | null | undefined;
  chatModel: string;
}): RunSettings {
  const effective = effectivePreset(o.presets, o.machine, { ...defaultSettings(), ...(o.settings ?? {}) });
  return {
    params: o.machine.answer,
    scope: answerScopeOf(o.settings),
    chatModel: o.chatModel,
    contextLength: effective.contextLength,
    chunkMaxChars: o.machine.chunkMaxChars,
    temperature: o.machine.temperature,
  };
}

/** The preset with the settings applied: what the server runs with. */
export function effectivePreset(presets: PresetFile, machine: Preset, s: Settings): Preset {
  const models = modelChoices(presets, machine);
  const chat = s.answerModel === 'faster' && models.faster ? models.faster.model : machine.chatModel;
  return { ...machine, chatModel: chat, contextLength: s.contextLength ?? machine.contextLength };
}

/** The server .env lines the settings decide. */
export function settingsEnv(p: Preset): EnvEntry[] {
  return [
    ['OLLAMA_MODEL_PREF', p.chatModel],
    ['OLLAMA_MODEL_TOKEN_LIMIT', String(p.contextLength)],
  ];
}

export function settingsView(presets: PresetFile, machine: Preset, s: Settings): SettingsView {
  return {
    values: { ...s },
    models: modelChoices(presets, machine),
    contextDefault: machine.contextLength,
    contextChoices: CONTEXT_LENGTHS,
    scopes: ANSWER_SCOPES,
  };
}

/**
 * Checks a change a page sends. Unknown keys are ignored; a bad value is an error. Faster on a Mac
 * without a lower tier is refused rather than silently kept as Better.
 */
export function checkSettingsChange(change: unknown, models: SettingsView['models']): Partial<Settings> {
  const c = (change && typeof change === 'object' ? change : {}) as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if ('answerScope' in c) {
    if (!ANSWER_SCOPES.includes(c.answerScope as AnswerScope)) throw new Error('Unknown answer scope.');
    out.answerScope = c.answerScope as AnswerScope;
  }
  if ('answerModel' in c) {
    if (!ANSWER_MODELS.includes(c.answerModel as AnswerModel)) throw new Error('Unknown answer model.');
    if (c.answerModel === 'faster' && !models.faster) throw new Error('This Mac has no faster model to choose.');
    out.answerModel = c.answerModel as AnswerModel;
  }
  if ('contextLength' in c) {
    if (c.contextLength !== null && !CONTEXT_LENGTHS.includes(c.contextLength as number)) {
      throw new Error('Unknown context length.');
    }
    out.contextLength = c.contextLength as number | null;
  }
  return out;
}
