/**
 * The one-sentence summaries (docs/summaries.md): prompts, length caps and verification. A summary
 * is checked like an Ask sentence (src/main/answer/verify.ts, verifyClaims with cjkOverlap) against
 * the text the model was given; one that the text does not support is dropped, never shown.
 */
import type { ChatMessage } from '../answer/prompt.js';
import { mainlyCjk, verifyClaims } from '../answer/verify.js';
import type { BrowseDocument, BrowseSection } from '../browse/types.js';

/**
 * Bumped whenever a prompt or the cleaning changes, so stored summaries become stale and are made
 * again (docs/summaries.md, Version key).
 */
export const SUMMARY_PROMPT_VERSION = 1;
/**
 * The prompt version of a mainly Chinese document's summaries: 2 since the Chinese caps went to
 * 100 characters in up to two sentences and 60 for a section (owner request 2026-11-04). Apart from
 * the English one, so the change remakes only Chinese summaries. 3: the Chinese document prompt
 * asks for two sentences (what the document is; three to five main topics), 60 to 100 characters,
 * and the section prompts for the concrete rule or content in 30 to 60 characters.
 */
export const SUMMARY_PROMPT_VERSION_CJK = 3;

/** The prompt version for a document: the Chinese one when its summary source is mainly Chinese. */
export function promptVersionOf(doc: BrowseDocument): number {
  return mainlyCjk(documentSource(doc).text) ? SUMMARY_PROMPT_VERSION_CJK : SUMMARY_PROMPT_VERSION;
}

export type SummaryLevel = 'document' | 'section';

/**
 * At most this many English words, or Chinese characters for a mainly Chinese summary, in at most
 * this many sentences. English summaries are one sentence; a Chinese document summary may take two.
 */
export const CAPS: Record<SummaryLevel, { words: number; cjkChars: number; cjkSentences: number }> = {
  document: { words: 40, cjkChars: 100, cjkSentences: 2 },
  section: { words: 25, cjkChars: 60, cjkSentences: 1 },
};

/** Text of the first section given to the document prompt, and of a section to its prompt. */
const DOCUMENT_TEXT_CHARS = 3000;
const SECTION_TEXT_CHARS = 4000;
const OUTLINE_ENTRIES = 30;

const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g;

/** Words of a summary as the cap counts them: Latin words and numbers. */
export function wordCount(text: string): number {
  return text.replace(CJK_RUN, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** Chinese, Japanese and Korean characters, plus Latin words, for a mainly CJK summary. */
export function cjkLength(text: string): number {
  return (text.match(CJK_RUN)?.length ?? 0) + wordCount(text);
}

export function withinCap(text: string, level: SummaryLevel): boolean {
  const cap = CAPS[level];
  return mainlyCjk(text) ? cjkLength(text) <= cap.cjkChars : wordCount(text) <= cap.words;
}

/**
 * The model's reply as one sentence: thinking, quotes, a leading label (Summary:, 摘要：), list
 * marks and citation marks taken off; only the first sentence kept.
 */
export function cleanSentence(raw: string, maxSentences = 1): string {
  let t = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .trim();
  t = t.split(/\n+/).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? '';
  t = t
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/^\s*(?:summary|one-sentence summary|sentence|摘要|总结|概述)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
    .trim();
  const kept: string[] = [];
  let rest = t;
  while (kept.length < maxSentences && rest) {
    const end = /^(.*?[.!?。！？])["'”’」』]*(?=\s|$|[\p{Lu}㐀-鿿])/u.exec(rest);
    if (!end) {
      // Text without an end mark counts as one sentence only when it is the first.
      if (!kept.length) kept.push(rest);
      break;
    }
    kept.push(end[1]!);
    rest = rest.slice(end[0].length).trim();
  }
  return kept
    .map((x) => x.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/([。！？]) (?=[㐀-鿿])/g, '$1')
    .trim();
}

/** Sentences of a cleaned Chinese summary, split on the Chinese end marks only (3.5% stays whole). */
function cjkSentencesOf(text: string): string[] {
  return (text.match(/[^。！？]+[。！？]+["'”’」』]*|[^。！？]+$/gu) ?? [text]).map((x) => x.trim()).filter(Boolean);
}

function capLine(level: SummaryLevel, chinese: boolean): string {
  const cap = CAPS[level];
  if (!chinese) return `Write the sentence in English, at most ${cap.words} words.`;
  return cap.cjkSentences > 1
    ? `Write two sentences in Chinese, 60 to 100 Chinese characters in all, never more than ${cap.cjkChars}.`
    : `Write the sentence in Chinese, 30 to 60 Chinese characters, never more than ${cap.cjkChars}.`;
}

/** What a Chinese section summary must say: the rule or content itself, not the topic's name. */
const CJK_SECTION_RULE =
  'State the concrete rule or content of the section (who must do what, amounts, time limits, conditions), ' +
  'not the name of its topic: not 本节介绍投标保证金 but 投标保证金不得超过招标项目估算价的2%。';

const RULES =
  'Use only facts stated in the text you are given; do not add anything from elsewhere. ' +
  'Reply with the sentence alone: no preamble, no label, no quotes, no list, no citation marks.';

function topOutline(doc: BrowseDocument): string[] {
  return doc.outline.slice(0, OUTLINE_ENTRIES).map((e) => e.title.replace(/\s+/g, ' ').trim());
}

/** What the document summary is made from and checked against: title, outline, first section. */
export function documentSource(doc: BrowseDocument): { section: BrowseSection | null; text: string } {
  const section = doc.sections.find((s) => s.text.trim()) ?? doc.sections[0] ?? null;
  const outline = topOutline(doc);
  const text = [
    `Title: ${doc.title}`,
    outline.length ? `Outline: ${outline.join('; ')}` : '',
    section ? `First section (${section.title}):\n${section.text.slice(0, DOCUMENT_TEXT_CHARS)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (!mainlyCjk(text)) return { section, text };
  // A Chinese summary names three to five main topics in its second sentence, so it needs them in
  // its source: the outline down to three levels (articles, numbered clauses) and the text of the
  // first sections in order within the same budget. English sources stay as they were.
  const deep = outlineTitles(doc.outline, 3).slice(0, OUTLINE_ENTRIES);
  let budget = DOCUMENT_TEXT_CHARS;
  const parts: string[] = [];
  for (const s of doc.sections) {
    if (budget <= 0) break;
    if (!s.text.trim()) continue;
    const body = s.text.slice(0, budget);
    budget -= body.length;
    parts.push(`${s.title}:\n${body}`);
  }
  return {
    section,
    text: [
      `Title: ${doc.title}`,
      deep.length ? `Outline: ${deep.join('; ')}` : '',
      parts.length ? `Text:\n${parts.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Outline titles to a depth, in document order, each title once. */
function outlineTitles(entries: BrowseDocument['outline'], depth: number, out: string[] = []): string[] {
  for (const e of entries) {
    const t = e.title.replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
    if (depth > 1) outlineTitles(e.children, depth - 1, out);
  }
  return out;
}

export function sectionSource(doc: BrowseDocument, section: BrowseSection): string {
  const path = section.path.length ? section.path.join(' > ') : section.title;
  return `Document: ${doc.title}\nSection: ${path}\n${section.text.slice(0, SECTION_TEXT_CHARS)}`;
}

export function documentPrompt(doc: BrowseDocument, opts: { shorter?: boolean } = {}): ChatMessage[] {
  const { text } = documentSource(doc);
  const chinese = mainlyCjk(text);
  return [
    {
      role: 'system',
      content: chinese
        ? 'You write short summaries of documents in a personal file library, in exactly two sentences. ' +
          'The first sentence says what the document is, with its issuer and date when the text gives them. ' +
          'The second sentence names three to five of its main topics or sections, taken from the outline. ' +
          'Use only facts stated in the text you are given; do not add anything from elsewhere. ' +
          'Reply with the summary alone: no preamble, no label, no quotes, no list, no citation marks. ' +
          `${capLine('document', true)}${opts.shorter ? ' Keep it well under that length.' : ''}`
        : 'You write one-sentence summaries of documents in a personal file library. ' +
          'The sentence says what the document is and what it covers. ' +
          `${RULES} ${capLine('document', false)}${opts.shorter ? ' Keep it well under that length.' : ''}`,
    },
    { role: 'user', content: text },
  ];
}

export function sectionPrompt(
  doc: BrowseDocument,
  section: BrowseSection,
  opts: { shorter?: boolean } = {},
): ChatMessage[] {
  const text = sectionSource(doc, section);
  const chinese = mainlyCjk(section.text || section.title);
  return [
    {
      role: 'system',
      content:
        'You write one-sentence summaries of sections of a document. The sentence says what this section states. ' +
        `${chinese ? `${CJK_SECTION_RULE} ` : ''}${RULES} ${capLine('section', chinese)}${opts.shorter ? ' Keep it well under that length.' : ''}`,
    },
    { role: 'user', content: text },
  ];
}

/**
 * Sections per model call (docs/summaries.md, Batches). One call for several short sections costs
 * little more than one for a single section: the prompt is read once and the replies are short.
 */
export const BATCH_MAX_SECTIONS = 5;
/** Estimated input tokens of one batch, so it fits the 8192 context with room for the replies. */
export const BATCH_MAX_TOKENS = 4000;

/** A rough token count: one per Chinese character, one per four other characters. */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK_RUN)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * One prompt for several sections of a document. Each section is numbered; the reply is one line
 * per section, starting with its number. Every sentence is then checked against its own section
 * alone, exactly as a single summary is (checkSummary with sectionSource).
 */
export function sectionBatchPrompt(doc: BrowseDocument, sections: BrowseSection[]): ChatMessage[] {
  const chinese = mainlyCjk(sections.map((s) => s.text || s.title).join('\n'));
  const n = sections.length;
  const body = sections
    .map((s, i) => `[${i + 1}] ${sectionSource(doc, s).split('\n').slice(1).join('\n')}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        `You write one-sentence summaries of sections of a document. You are given ${n} numbered sections. ` +
        'For each one write one sentence that says what that section states, using only facts stated in that section. ' +
        `Reply with exactly ${n} lines and nothing else, in order; each line starts with the section number and a period, ` +
        'like "1. The section ...". No preamble, no quotes, no citation marks. ' +
        (chinese ? `${CJK_SECTION_RULE} ` : '') +
        capLine('section', chinese).replace('the sentence', 'each sentence'),
    },
    { role: 'user', content: `Document: ${doc.title}\n\n${body}` },
  ];
}

/** The reply's sentence per section number (1-based); a number the model skipped is missing. */
export function parseBatchReply(raw: string, n: number): Map<number, string> {
  const out = new Map<number, string>();
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  for (const line of text.split(/\n+/)) {
    const m = /^\s*(?:\*\*)?(?:\[(\d{1,2})\]|(\d{1,2})[.):：、])(?:\*\*)?\s*(.+)$/.exec(line);
    if (!m) continue;
    const i = Number(m[1] ?? m[2]);
    if (i >= 1 && i <= n && !out.has(i) && m[3]!.trim()) out.set(i, m[3]!.trim());
  }
  return out;
}

export type CheckOutcome = { ok: true; text: string } | { ok: false; reason: 'empty' | 'too-long' | 'unsupported' };

/**
 * A cleaned reply that fits the cap and that the source supports (the Ask threshold: half of its
 * content words, 0.3 of its character pairs for Chinese). A Chinese document summary may have two
 * sentences: each is checked on its own, an unsupported one is left out, and the summary is
 * dropped only when no sentence is supported.
 */
export function checkSummary(raw: string, source: string, level: SummaryLevel): CheckOutcome {
  const chinese = mainlyCjk(source);
  const text = cleanSentence(raw, chinese ? CAPS[level].cjkSentences : 1);
  if (!/[\p{L}\p{N}]{2}/u.test(text)) return { ok: false, reason: 'empty' };
  if (!withinCap(text, level)) return { ok: false, reason: 'too-long' };
  // English summaries are one sentence; only a Chinese one may hold two.
  const sentences = chinese ? cjkSentencesOf(text) : [text];
  const { claims } = verifyClaims(
    sentences.map((t) => ({ text: t, citations: [1], unsupported: false })),
    [source],
    { cjk: true },
  );
  const kept = sentences.filter((_, i) => !claims[i]!.unsupported);
  if (!kept.length) return { ok: false, reason: 'unsupported' };
  return { ok: true, text: kept.join('') };
}

/** sha256-free fingerprint of a text, for knowing when a section changed (FNV-1a, hex). */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + text.length.toString(16);
}
