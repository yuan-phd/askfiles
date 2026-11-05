/**
 * The model call's messages. The sources carry a number, the section path and the text, never a
 * file name or a page: the source cards add those from the section records, so the model has no
 * way to attribute one file's text to another. With documentAffinity each source header names its
 * file and document type too, because questions that name a file were answered from a same-titled
 * section of another (docs/plan.md round 7); the answer still may not write them.
 */
import { ENUMERATE_RULE, NO_SUMMARIZING_RULE } from './enumerate.js';
import type { PromptVariant } from './params.js';

/** The whole reply when the sources do not answer the question. */
export const NOT_FOUND_MARKER = 'NOT_IN_SOURCES';

const RULES = [
  'Answer the question using only the numbered sources below.',
  'After each sentence that uses a source, cite it as [n], for example [1] or [2][3].',
  'Never write page numbers, file names or section names in your answer; the citations are enough.',
  // A firmer wording (must start with the marker, never explain in own words, with an example) was
  // tried on 2026-10-31: qwen3:14b then refused three answerable multi-part questions whose one
  // part (a page number) was missing; target hit fell from 67 to 44 percent (docs/plan.md).
  `If the sources do not state the specific fact the question asks for, reply with ${NOT_FOUND_MARKER}, even when they discuss related material: do not answer from related material or from placeholders.`,
  `After ${NOT_FOUND_MARKER} you may add one short sentence saying which sources you checked, cited as [n]; nothing else.`,
  'Answer in the language of the question.',
];

const STRICT_RULES = [
  'Every sentence of your answer must end with at least one citation.',
  'Do not add background knowledge, advice or guesses that the sources do not state.',
  'Keep the answer short: the fewest sentences that answer the question.',
];

/**
 * crossDocument (round A2), in place of the rule against file names: a question about several
 * files gets its sources grouped under each file's name and is answered one file at a time, each
 * part citing only that file, then compared. The part names its file so that verification can
 * keep a sentence on the sources of the file it is about.
 */
export const CROSS_DOCUMENT_RULES = [
  'Never write page numbers or section names in your answer; the citations are enough.',
  'The question asks about several files. The sources are grouped under a line naming their file.',
  "First answer for each file in turn, in its own paragraph that names the file as the question does and cites only that file's sources.",
  'Then compare the files in a last paragraph.',
];

/** verdictLine: the first line of the reply, which code reads instead of looking for the marker. */
export const VERDICT_FOUND = 'FOUND';
export const VERDICT_NOT_FOUND = 'NOT_FOUND';

const VERDICT_RULES = [
  `Begin your reply with one line containing only ${VERDICT_FOUND} or ${VERDICT_NOT_FOUND}.`,
  `Write ${VERDICT_NOT_FOUND} when the sources do not state the specific fact the question asks for, even when they discuss related material or hold placeholders; write nothing after it.`,
  `Write ${VERDICT_FOUND} when they do, then the answer from the next line on.`,
];

// Answers paraphrased the sources and left out conditions and figures (round 2' causes, docs/plan.md).
const COMPLETE_RULES = [
  'Name every condition, exception, step and figure in the cited sources that bears on the question.',
  "Use the sources' own terms, names and numbers; do not paraphrase them.",
];

export function systemPrompt(
  variant: PromptVariant,
  o: { verdictLine?: boolean; enumerate?: boolean; noSummarizing?: boolean; crossDocument?: boolean } = {},
): string {
  // The verdict rules take the place of the two not-found marker rules.
  const marked = o.verdictLine ? [...RULES.slice(0, 3), ...VERDICT_RULES, ...RULES.slice(5)] : RULES;
  const base = o.crossDocument ? [...marked.slice(0, 2), ...CROSS_DOCUMENT_RULES, ...marked.slice(3)] : marked;
  const extra = [
    ...(variant === 'strict' ? STRICT_RULES : variant === 'complete' ? COMPLETE_RULES : []),
    // noSummarizing takes the place of the enumerateWhenAsked rule, which set questions only got.
    ...(o.noSummarizing ? [NO_SUMMARIZING_RULE] : o.enumerate ? [ENUMERATE_RULE] : []),
  ];
  const head = o.crossDocument ? 2 + CROSS_DOCUMENT_RULES.length : 3;
  const rules = [...base.slice(0, head), ...extra, ...base.slice(head)];
  return rules.join('\n');
}

export type Verdict = 'found' | 'not_found';

/**
 * Reads the verdict line at the start of a reply. complete is false while the first line may still
 * grow into a verdict; verdict is null when the reply does not start with one, and rest is then
 * the whole reply. Formatting around the word (**FOUND**, # FOUND, a colon) is ignored.
 */
export function readVerdict(text: string): { complete: boolean; verdict: Verdict | null; rest: string } {
  const t = text.replace(/^\s+/, '');
  const nl = t.indexOf('\n');
  const line = (nl < 0 ? t : t.slice(0, nl)).replace(/[\s`*"'>#:.-]+/g, '').toUpperCase();
  const words = [VERDICT_FOUND, VERDICT_NOT_FOUND, 'NOTFOUND'];
  if (nl < 0 && words.some((w) => w.startsWith(line))) return { complete: false, verdict: null, rest: '' };
  const rest = nl < 0 ? '' : t.slice(nl + 1);
  if (line === VERDICT_NOT_FOUND || line === 'NOTFOUND') return { complete: true, verdict: 'not_found', rest };
  if (line === VERDICT_FOUND) return { complete: true, verdict: 'found', rest };
  return { complete: true, verdict: null, rest: text };
}

export interface PromptSource {
  path: string[];
  text: string;
  /** File name; shown only with fileHeaders. */
  file?: string;
  /** Document type of the file (Policy, Guidance); '' when it has none. */
  type?: string;
  title?: string;
  /** crossDocument: the file the source is grouped under; '' for the files the question does not name. */
  group?: string;
  /** sourceFileNames: the file's display name (displayName in browse/identifiers.ts). */
  display?: string;
}

/** [n] file | type | full path, and a note when another source has the same section title. */
export function sourceHeader(sources: PromptSource[], i: number): string {
  const s = sources[i]!;
  const title = (s.title ?? s.path[s.path.length - 1] ?? '').trim().toLowerCase();
  const twins = sources
    .map((o, j) => ({ o, j }))
    .filter(
      ({ o, j }) =>
        j !== i &&
        title &&
        o.file !== s.file &&
        (o.title ?? o.path[o.path.length - 1] ?? '').trim().toLowerCase() === title,
    )
    .map(({ j }) => `[${j + 1}]`);
  const fields = [s.file ?? '', s.type ?? '', s.path.join(' > ')].filter(Boolean).join(' | ');
  const note = twins.length ? ` (same section title as ${twins.join('')}, but from a different file)` : '';
  return `[${i + 1}] ${fields}${note}`;
}

/**
 * sourceFileNames (docs/plan.md round N1): [n] display name (file name) > heading path, one line,
 * the same for every language. Only the prompt carries it: verification and the source cards use
 * the section text and records.
 */
export function fileNameHeader(s: Pick<PromptSource, 'path' | 'file' | 'display'>, i: number): string {
  return `[${i + 1}] ${s.display || s.file} (${s.file}) > ${s.path.join(' > ')}`;
}

export function userMessage(
  question: string,
  sources: PromptSource[],
  o: { fileHeaders?: boolean; grouped?: boolean; fileNames?: boolean; displayNames?: boolean } = {},
): string {
  const blocks = sources.map((s, i) => {
    const header = o.fileHeaders
      ? sourceHeader(sources, i)
      : o.fileNames && s.file
        ? fileNameHeader(s, i)
        : o.displayNames && s.file
          ? `[${i + 1}] ${s.display || s.file} > ${s.path.join(' > ')}`
          : `[${i + 1}] ${s.path.join(' > ')}`;
    const block = `${header}\n${s.text.trim()}`;
    // grouped: sources come ordered by file, with a line naming the file before each group.
    if (!o.grouped || (i > 0 && sources[i - 1]!.group === s.group)) return block;
    return `${s.group ? `Sources from ${s.group}:` : 'Sources from other files:'}\n\n${block}`;
  });
  return `Sources:\n\n${blocks.join('\n\n')}\n\nQuestion: ${question.trim()}`;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildMessages(
  question: string,
  sources: PromptSource[],
  variant: PromptVariant,
  o: {
    verdictLine?: boolean;
    fileHeaders?: boolean;
    enumerate?: boolean;
    noSummarizing?: boolean;
    crossDocument?: boolean;
    grouped?: boolean;
    fileNames?: boolean;
    displayNames?: boolean;
  } = {},
): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(variant, o) },
    { role: 'user', content: userMessage(question, sources, o) },
  ];
}

/**
 * True when the reply means the sources do not answer: it starts with the marker (formatting
 * around it ignored), or it holds the marker and cites nothing.
 */
export function isNotFound(answer: string): boolean {
  const t = answer.replace(/^[\s`*"'>#-]+/, '');
  if (t.startsWith(NOT_FOUND_MARKER)) return true;
  return t.includes(NOT_FOUND_MARKER) && !/[[【]\s*\d+\s*[\]】]/.test(t);
}
