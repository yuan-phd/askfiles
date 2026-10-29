import { docTitleOf, paragraphs } from './text.js';
import type { ParsedDocument, Section } from './types.js';

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

/**
 * Sections from Markdown headings: ATX (# to ######) and setext (=== and --- underlines).
 * Lines inside fenced code blocks are never headings. Text before the first heading becomes a
 * section titled by the file name.
 */
export function parseMarkdown(source: string, fileName: string): ParsedDocument {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  let current = { title: docTitleOf(fileName), level: 0, lines: [] as string[] };
  const flush = () => {
    const blocks = paragraphs(current.lines.join('\n'));
    if (current.level > 0 || blocks.length) sections.push({ title: current.title, level: current.level, blocks });
  };
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      current.lines.push(line);
      continue;
    }
    if (fence !== null) {
      current.lines.push(line);
      continue;
    }
    const atx = ATX.exec(line);
    const next = lines[i + 1];
    const setext = line.trim() && next !== undefined && SETEXT.exec(next);
    // A --- under a paragraph's last line is a heading only when the line before is blank,
    // otherwise a wrapped paragraph followed by a rule would lose its last line.
    const setextOk = setext && (i === 0 || !lines[i - 1]!.trim());
    if (atx || setextOk) {
      flush();
      const title = atx ? atx[2]!.trim() : line.trim();
      const level = atx ? atx[1]!.length : setext && setext[1]![0] === '=' ? 1 : 2;
      current = { title, level, lines: [] };
      if (!atx) i++;
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return { sections, outline: sections.some((s) => s.level > 0) ? 'headings' : 'none', pages: 0, needsOcr: false };
}
