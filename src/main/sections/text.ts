import type { Block, ParsedDocument, Section } from './types.js';

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && CJK.test(ch);
}

/** Joins two pieces of one wrapped line: a space between Latin words, nothing next to Chinese. */
export function joinWrapped(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return isCjk(a[a.length - 1]) || isCjk(b[0]) ? a + b : `${a} ${b}`;
}

/** Collapses runs of spaces and tabs, keeps line breaks, trims each line. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .trim();
}

/** Paragraphs separated by blank lines, each as one block on the given page. */
export function paragraphs(text: string, page = 0): Block[] {
  return tidy(text)
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ text: t, page }));
}

/** File name without its extension, used as the title of text before the first heading. */
export function docTitleOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A document without structure: one section titled by the file name. */
export function parsePlainText(text: string, fileName: string): ParsedDocument {
  const blocks = paragraphs(text);
  const sections: Section[] = blocks.length ? [{ title: docTitleOf(fileName), level: 0, blocks }] : [];
  return { sections, outline: 'none', pages: 0, needsOcr: false };
}
