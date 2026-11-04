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

export type SummaryLevel = 'document' | 'section';

/** At most this many English words, or Chinese characters for a mainly Chinese summary. */
export const CAPS: Record<SummaryLevel, { words: number; cjkChars: number }> = {
  document: { words: 40, cjkChars: 50 },
  section: { words: 25, cjkChars: 35 },
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
export function cleanSentence(raw: string): string {
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
  const end = /^(.*?[.!?。！？])["'”’」』]*(?=\s|$|[\p{Lu}㐀-鿿])/u.exec(t);
  return (end ? end[1]! : t)
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function capLine(level: SummaryLevel, chinese: boolean): string {
  const cap = CAPS[level];
  return chinese
    ? `Write the sentence in Chinese, at most ${cap.cjkChars} Chinese characters.`
    : `Write the sentence in English, at most ${cap.words} words.`;
}

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
  return { section, text };
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
      content:
        'You write one-sentence summaries of documents in a personal file library. ' +
        'The sentence says what the document is and what it covers. ' +
        `${RULES} ${capLine('document', chinese)}${opts.shorter ? ' Keep it well under that length.' : ''}`,
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
        `${RULES} ${capLine('section', chinese)}${opts.shorter ? ' Keep it well under that length.' : ''}`,
    },
    { role: 'user', content: text },
  ];
}

export type CheckOutcome = { ok: true; text: string } | { ok: false; reason: 'empty' | 'too-long' | 'unsupported' };

/**
 * A cleaned reply that fits the cap and that the source supports (the Ask threshold: half of its
 * content words, 0.3 of its character pairs for Chinese).
 */
export function checkSummary(raw: string, source: string, level: SummaryLevel): CheckOutcome {
  const text = cleanSentence(raw);
  if (!/[\p{L}\p{N}]{2}/u.test(text)) return { ok: false, reason: 'empty' };
  if (!withinCap(text, level)) return { ok: false, reason: 'too-long' };
  const { claims } = verifyClaims([{ text, citations: [1], unsupported: false }], [source], { cjk: true });
  return claims[0]!.unsupported ? { ok: false, reason: 'unsupported' } : { ok: true, text };
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
