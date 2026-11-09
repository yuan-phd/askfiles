// The small Markdown subset an answer is shown with: paragraphs, line breaks, bulleted and numbered
// lists (nested by indentation), bold, italic and inline code. Everything else (headings, tables,
// links, images, HTML) stays plain text. The DOM is built with createElement and text nodes only,
// so nothing in an answer can run script or load anything.
//
// Verification reads the same answer with this syntax removed; src/main/answer/markdown.ts is the
// main process copy of scan() and plainText(), and markdown.test.js checks the two agree.
//
// Simplifications against CommonMark: emphasis and code spans stay within one line; any line
// starting with a list marker starts or continues a list; a character of a Chinese, Japanese or
// Korean run counts as punctuation next to * and _, so **要求：**内容 closes as the model means it.

const ITEM = /^([ \t]*)([*+-]|\d{1,9}[.)])([ \t]+|$)/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef\u3000-\u303f]/;
const SPACE = /\s/u;
// Private-use characters stand in for citations and the unsupported marker on the Ask page; next
// to a delimiter they count as punctuation, as the [n] they replace would.
const PUNCT = /[\p{P}\p{S}\p{Co}]/u;

const isSpace = (ch) => ch === undefined || SPACE.test(ch);
const isPunct = (ch) => ch !== undefined && (PUNCT.test(ch) || CJK.test(ch));

/** Columns of leading whitespace, a tab as four. */
function indentOf(ws) {
  let n = 0;
  for (const ch of ws) n += ch === '\t' ? 4 : 1;
  return n;
}

/**
 * One line's inline structure. from and to bound the content in src. Returns events sorted by
 * position: { at, kind: 'open' | 'close', type: 'strong' | 'em' } and { at, kind: 'code', from, to },
 * plus removed, the ranges of syntax characters (delimiters used, backticks, escape backslashes).
 * autoClose (streaming, last line): an opener still waiting for its closer is opened anyway, and
 * an unclosed code span runs to the end of the line, so nothing half-typed shows as a marker.
 */
export function scanInline(src, from, to, { autoClose = false } = {}) {
  const removed = [];
  const events = [];
  const delims = [];
  const codes = [];
  let i = from;
  while (i < to) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < to && ESCAPABLE.test(src[i + 1])) {
      removed.push([i, i + 1]);
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (i + n < to && src[i + n] === '`') n++;
      // The closing run of exactly the same length.
      let j = i + n;
      let close = -1;
      while (j < to) {
        if (src[j] !== '`') {
          j++;
          continue;
        }
        let m = 1;
        while (j + m < to && src[j + m] === '`') m++;
        if (m === n) {
          close = j;
          break;
        }
        j += m;
      }
      if (close < 0 && !autoClose) {
        i += n;
        continue;
      }
      const end = close < 0 ? to : close;
      let a = i + n;
      let b = end;
      // One space on each side is padding when both are there and the content is not all spaces.
      if (b - a >= 2 && src[a] === ' ' && src[b - 1] === ' ' && /[^ ]/.test(src.slice(a, b))) {
        a++;
        b--;
      }
      removed.push([i, a]);
      if (close >= 0) removed.push([b, close + n]);
      codes.push({ at: i, kind: 'code', from: a, to: b });
      i = close < 0 ? to : close + n;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let n = 1;
      while (i + n < to && src[i + n] === ch) n++;
      const before = i > from ? src[i - 1] : undefined;
      const after = i + n < to ? src[i + n] : undefined;
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const canOpen = ch === '*' ? left : left && (!right || isPunct(before));
      const canClose = ch === '*' ? right : right && (!left || isPunct(after));
      delims.push({ ch, len: n, lo: i, hi: i + n, canOpen, canClose, before, dead: false });
      i += n;
      continue;
    }
    i++;
  }
  // CommonMark's process emphasis: each closer takes the nearest matching opener; the openers
  // between them can no longer match. [lo, hi) is the part of a run still unused: an opener gives
  // up characters from its right end, a closer from its left end.
  for (let c = 0; c < delims.length; c++) {
    const closer = delims[c];
    if (!closer.canClose) continue;
    while (closer.hi > closer.lo) {
      let o = c - 1;
      for (; o >= 0; o--) {
        const d = delims[o];
        if (d.dead || d.ch !== closer.ch || !d.canOpen || d.hi === d.lo) continue;
        const odd = (d.canClose || closer.canOpen) && (d.len + closer.len) % 3 === 0 && (d.len % 3 || closer.len % 3);
        if (!odd) break;
      }
      if (o < 0) break;
      const opener = delims[o];
      const use = opener.hi - opener.lo >= 2 && closer.hi - closer.lo >= 2 ? 2 : 1;
      const type = use === 2 ? 'strong' : 'em';
      const oAt = opener.hi - use;
      const cAt = closer.lo;
      removed.push([oAt, oAt + use], [cAt, cAt + use]);
      events.push({ at: oAt, kind: 'open', type, end: oAt + use }, { at: cAt, kind: 'close', type, end: cAt + use });
      opener.hi -= use;
      closer.lo += use;
      for (let k = o + 1; k < c; k++) delims[k].dead = true;
    }
  }
  if (autoClose) {
    // Openers still alive after a letter or digit stay text (2*3); the others open to line end.
    for (const d of delims) {
      if (d.dead || !d.canOpen || d.hi === d.lo || /[A-Za-z0-9]/.test(d.before ?? '')) continue;
      for (let at = d.lo; at < d.hi;) {
        const use = d.hi - at >= 2 ? 2 : 1;
        removed.push([at, at + use]);
        events.push({ at, kind: 'open', type: use === 2 ? 'strong' : 'em', end: at + use });
        at += use;
      }
    }
  }
  // The scan jumps over a code span, so no delimiter or escape lies inside one.
  return { events: [...events, ...codes].sort((a, b) => a.at - b.at), removed: removed.sort((a, b) => a[0] - b[0]) };
}

/**
 * The lines of src with their kind: blank, item (a list marker; markerEnd is where its content
 * starts) or text. A trailing line break leaves no empty last line.
 */
export function scanLines(src) {
  const lines = [];
  let start = 0;
  while (start <= src.length) {
    let end = src.indexOf('\n', start);
    if (end < 0) end = src.length;
    const text = src.slice(start, end);
    const m = ITEM.exec(text);
    if (!text.trim()) lines.push({ kind: 'blank', start, end });
    else if (m)
      lines.push({
        kind: 'item',
        start,
        end,
        indent: indentOf(m[1]),
        ordered: /\d/.test(m[2]),
        number: /\d/.test(m[2]) ? Number(m[2].slice(0, -1)) : null,
        markerEnd: start + m[0].length,
      });
    else lines.push({ kind: 'text', start, end, indent: indentOf(/^[ \t]*/.exec(text)[0]) });
    if (end === src.length) break;
    start = end + 1;
  }
  if (lines.length > 1 && lines[lines.length - 1].kind === 'blank' && lines[lines.length - 1].start === src.length)
    lines.pop();
  return lines;
}

/**
 * Every syntax character of src, as sorted [from, to) ranges: list markers with the indentation
 * before them and the spaces after, emphasis delimiters that pair, code span backticks and their
 * padding space, escape backslashes. Everything else is the answer's text.
 */
export function syntaxRanges(src) {
  const out = [];
  for (const line of scanLines(src)) {
    if (line.kind === 'blank') continue;
    const from = line.kind === 'item' ? line.markerEnd : line.start;
    if (line.kind === 'item') out.push([line.start, line.markerEnd]);
    out.push(...scanInline(src, from, line.end).removed);
  }
  return out.filter(([a, b]) => b > a);
}

/** src without its Markdown syntax, and map[i], the index in src of plain[i]. */
export function plainText(src) {
  const ranges = syntaxRanges(src);
  let plain = '';
  const map = [];
  let r = 0;
  for (let i = 0; i < src.length; i++) {
    while (r < ranges.length && ranges[r][1] <= i) r++;
    if (r < ranges.length && i >= ranges[r][0]) continue;
    plain += src[i];
    map.push(i);
  }
  return { plain, map };
}

/**
 * Text a stream may still turn into syntax, held back until the next chunk: delimiter characters
 * at the very end, and a last line that is only a possible list marker (-, *, 1, 1.).
 */
export function streamingCut(src) {
  let end = src.length;
  while (end > 0 && /[*_`\\]/.test(src[end - 1])) end--;
  const lineStart = src.lastIndexOf('\n', end - 1) + 1;
  if (/^[ \t]*(?:[+-]|\d{1,9}[.)]?)$/.test(src.slice(lineStart, end))) end = lineStart;
  return src.slice(0, end);
}

/**
 * Blocks of src: { type: 'p', lines } and { type: 'list', ordered, start, items }, where an item is
 * { paras: [lines], lists: [list] } and lines are the scanLines entries whose content is shown.
 */
export function parseBlocks(src) {
  const blocks = [];
  // Open list items, outermost first: { indent, item, list }.
  let stack = [];
  let para = null;
  let blank = false;
  const container = () => (stack.length ? stack[stack.length - 1].item.lists : blocks);
  for (const line of scanLines(src)) {
    if (line.kind === 'blank') {
      blank = true;
      para = null;
      continue;
    }
    if (line.kind === 'item') {
      while (stack.length && stack[stack.length - 1].indent > line.indent) stack.pop();
      const top = stack[stack.length - 1];
      let list;
      if (top && top.indent === line.indent && top.list.ordered === line.ordered) {
        list = top.list;
        stack.pop();
      } else {
        if (top && top.indent === line.indent) stack.pop();
        const parent = container();
        const last = parent[parent.length - 1];
        // A list goes on after a blank line between its items (a loose list).
        if (!stack.length && last?.type === 'list' && last.ordered === line.ordered && !para) list = last;
        else {
          list = { type: 'list', ordered: line.ordered, start: line.number ?? 1, items: [] };
          parent.push(list);
        }
      }
      const item = { paras: [[line]], lists: [] };
      list.items.push(item);
      stack.push({ indent: line.indent, item, list });
      para = null;
      blank = false;
      continue;
    }
    if (stack.length && (!blank || line.indent > 0)) {
      // Continuation of the deepest item that is less indented than the line.
      let k = stack.length - 1;
      if (blank) while (k > 0 && stack[k].indent >= line.indent) k--;
      stack = stack.slice(0, k + 1);
      const item = stack[k].item;
      if (blank || item.lists.length) item.paras.push([line]);
      else item.paras[item.paras.length - 1].push(line);
      blank = false;
      continue;
    }
    stack = [];
    if (para && !blank) para.lines.push(line);
    else {
      para = { type: 'p', lines: [line] };
      blocks.push(para);
    }
    blank = false;
  }
  return blocks;
}

/**
 * src as DOM. Options:
 *   streaming: the answer is still arriving (streamingCut, autoClose on the last line).
 *   nodes: a map from a private-use character in src to a function making the node shown in its
 *     place (citations, the unsupported marker), so they sit inside lists and bold text.
 *   spans: [{ from, to, make }]: text of src inside [from, to) goes into the element make() returns,
 *     one per piece (make(first) is true for the first piece), for the per-sentence spans.
 */
export function renderMarkdown(doc, src, { streaming = false, nodes = new Map(), spans = [] } = {}) {
  if (streaming) src = streamingCut(src);
  const frag = doc.createDocumentFragment();
  const lastLineStart = src.lastIndexOf('\n') + 1;
  const made = new Set();

  // Appends src[a, b) as text, split at placeholders and at span boundaries.
  function text(parent, a, b) {
    let i = a;
    while (i < b) {
      const span = spans.find((s) => i >= s.from && i < s.to);
      const stop = Math.min(b, span ? span.to : (spans.find((s) => s.from > i)?.from ?? b));
      let target = parent;
      if (span) {
        target = span.make(!made.has(span));
        made.add(span);
        parent.append(target);
      }
      let run = '';
      for (let k = i; k < stop; k++) {
        const make = nodes.get(src[k]);
        if (!make) {
          run += src[k];
          continue;
        }
        if (run) target.append(doc.createTextNode(run));
        run = '';
        target.append(make());
      }
      if (run) target.append(doc.createTextNode(run));
      i = stop;
    }
  }

  function inline(parent, from, to) {
    const { events, removed } = scanInline(src, from, to, { autoClose: streaming && from >= lastLineStart });
    const stack = [parent];
    let i = from;
    const flush = (until) => {
      // Text up to until, without the syntax characters in it.
      let a = i;
      for (const [x, y] of removed) {
        if (y <= a || x >= until) continue;
        if (x > a) text(stack[stack.length - 1], a, x);
        a = Math.max(a, y);
      }
      if (a < until) text(stack[stack.length - 1], a, until);
      i = until;
    };
    for (const e of events) {
      if (e.at < i) continue;
      flush(e.at);
      if (e.kind === 'code') {
        const code = doc.createElement('code');
        text(code, e.from, e.to);
        stack[stack.length - 1].append(code);
        i = Math.max(e.to, ...removed.filter(([x]) => x === e.to).map(([, y]) => y));
        continue;
      }
      if (e.kind === 'open') {
        const el = doc.createElement(e.type);
        stack[stack.length - 1].append(el);
        stack.push(el);
      } else if (stack.length > 1) stack.pop();
      i = e.end;
    }
    flush(to);
  }

  function lines(parent, list) {
    list.forEach((line, k) => {
      if (k) parent.append(doc.createElement('br'));
      inline(parent, line.kind === 'item' ? line.markerEnd : line.start, line.end);
    });
  }

  function block(parent, b) {
    if (b.type === 'p') {
      const p = doc.createElement('p');
      lines(p, b.lines);
      parent.append(p);
      return;
    }
    const el = doc.createElement(b.ordered ? 'ol' : 'ul');
    if (b.ordered && b.start !== 1) el.start = b.start;
    for (const item of b.items) {
      const li = doc.createElement('li');
      item.paras.forEach((para, k) => {
        if (k === 0) lines(li, para);
        else {
          const p = doc.createElement('p');
          lines(p, para);
          li.append(p);
        }
      });
      for (const sub of item.lists) block(li, sub);
      el.append(li);
    }
    parent.append(el);
  }

  for (const b of parseBlocks(src)) block(frag, b);
  return frag;
}
