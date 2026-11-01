import { joinWrapped } from './text.js';
import type { Block, Section, TableData } from './types.js';

/**
 * Tables as rows (structuredTables, docs/plan.md round I1). Every parser hands a table over as a
 * TableData block; tableSections turns it into a section of row lines, and chunkSections cuts such
 * a section only between rows and repeats the header line in every chunk, so a row read on its own
 * still says what each value is.
 */

const DIGIT = /[\d０-９]/u;
const NUMBER = /^[\d０-９.,，%％$€¥￥#()（）\s+-]+$/u;

/**
 * A first row is a header when it has two or more cells, all filled and all labels (isLabel), at
 * most half of them with a digit (Weighted Score (80%) is a label).
 */
export function looksLikeHeader(cells: string[]): boolean {
  const filled = cells.map((c) => c.trim()).filter(Boolean);
  return (
    filled.length >= 2 &&
    filled.length === cells.length &&
    filled.every(isLabel) &&
    filled.filter((c) => DIGIT.test(c)).length * 2 <= filled.length
  );
}

/**
 * A column label: a letter in it, at most 60 characters, not a bare number, not starting with a
 * digit, a currency sign, a bracket or punctuation (240 x Weighting is a value, （项目名称）招标人为
 * the middle of a sentence), no sentence punctuation or quotes inside, not one Chinese character
 * alone and no sentence or colon at its end.
 */
function isLabel(c: string): boolean {
  return (
    /\p{L}/u.test(c) &&
    c.length <= 60 &&
    !NUMBER.test(c) &&
    !/^[\d０-９$€¥￥#（([【「“‘,，、。.;；:：…•◾▪■□-]/u.test(c) &&
    !/[，。；、“”《》]|[.;,] /u.test(c) &&
    // A one-character CJK label (年, 月) is a fill-in blank's word, not a column name.
    !/^[\u3400-\u9fff]$/u.test(c) &&
    !/[.。;；:：,，]$/u.test(c)
  );
}

/** A cell of running text: it holds a clause break (，。；) or a Latin sentence break. */
function isProse(c: string): boolean {
  return /[，。；]|[.;,] \p{L}/u.test(c);
}

/**
 * One row as one line: Header: value | Header: value, empty cells left out. A row whose first
 * column is empty and whose first filled cell is text (a total row such as Overall Technical Score
 * | 240) keeps that cell as its own label. Without a header the filled cells are joined.
 */
export function formatRow(cells: string[], header: string[]): string {
  const clean = cells.map((c) => c.replace(/\s+/g, ' ').trim());
  if (!header.length) return clean.filter(Boolean).join(' | ');
  const firstFilled = clean.findIndex(Boolean);
  return clean
    .map((v, i) => {
      if (!v) return '';
      if (i === firstFilled && i > 0 && !DIGIT.test(v)) return v;
      const h = (header[i] ?? '').replace(/\s+/g, ' ').trim();
      return h && h !== v ? `${h}: ${v}` : v;
    })
    .filter(Boolean)
    .join(' | ');
}

export function headerLine(header: string[]): string {
  return header
    .map((h) => h.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ');
}

/** A headerless table as one text block: caption, then one line per row. */
function plainRows(b: Block): Block {
  const t = b.table!;
  const lines = [t.title, ...t.rows.map((r) => formatRow(r.cells, []))].filter(Boolean);
  return { text: lines.join('\n'), page: t.rows[0]?.page ?? b.page };
}

/** The rows of a table as blocks of a table section. */
function tableSection(t: TableData, title: string, level: number): Section {
  const caption = t.title && t.title !== title ? t.title : '';
  return {
    title,
    level,
    blocks: t.rows.map((r) => ({ text: formatRow(r.cells, t.header), page: r.page })).filter((b) => b.text),
    table: { header: headerLine(t.header), ...(caption ? { caption } : {}) },
  };
}

/**
 * Moves every table block with a header into a section of its own: titled by the table's caption, or else by the
 * section it stands in, one level below it. Text after a table in the same section goes on in a
 * section titled <title> (continued), so the order of the document is kept. A section that holds
 * nothing but one table (a spreadsheet sheet) becomes the table section itself, keeping its title;
 * the caption then goes above the header.
 */
export function tableSections(sections: Section[]): Section[] {
  return sections.flatMap((input) => {
    if (!input.blocks.some((b) => b.table)) return [input];
    // Without a header a table is most often layout (a form, a box, clause and text side by
    // side): it stays in its section as row lines, the way it was written before the switch.
    const s = { ...input, blocks: input.blocks.map((b) => (b.table && !b.table.header.length ? plainRows(b) : b)) };
    if (!s.blocks.some((b) => b.table)) return [s];
    const only = s.blocks.length === 1 ? s.blocks[0]!.table : undefined;
    if (only) {
      return [{ ...tableSection(only, s.title, s.level), lead: s.lead, path: s.path }];
    }
    const out: Section[] = [];
    const level = Math.max(1, s.level + 1);
    let text: Block[] = [];
    let first = true;
    const flush = () => {
      if (first) out.push({ ...s, blocks: text });
      else if (text.length) out.push({ title: `${s.title} (continued)`, level, blocks: text });
      first = false;
      text = [];
    };
    for (const b of s.blocks) {
      if (!b.table) {
        text.push(b);
        continue;
      }
      flush();
      out.push(tableSection(b.table, b.table.title || s.title, level));
    }
    if (text.length) flush();
    return out.filter((x) => x.blocks.length || x === out[0]);
  });
}

// ---------------------------------------------------------------------------------------------
// PDF tables from text positions

export interface PdfItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

interface Piece {
  x0: number;
  x1: number;
  y: number;
  size: number;
  text: string;
}

interface VLine {
  y: number;
  size: number;
  segs: Piece[];
  /** Indexes of the items on this line. */
  items: number[];
}

/** A table found on a page, with the items it used (removed from the body text). */
export interface PdfTable {
  table: TableData;
  page: number;
  /** Baseline of the table's top line, for its position among the page's lines. */
  top: number;
  bottom: number;
  size: number;
  used: Set<number>;
}

/** Gap between two pieces of one cell is below this many font sizes; a column gap is at least it. */
const COLUMN_GAP = 0.75;
/** Lines of a table are at most this many font sizes apart. */
const ROW_GAP = 2.6;
/**
 * Lines of one cell are at most this many font sizes apart (1.2 to 1.35 in the owner's files);
 * rows start further apart (1.6 and more).
 */
const STACK = 1.4;
/** A one-piece line inside a table is narrower than this share of the text width. */
const NARROW = 0.45;

function piecesOf(items: PdfItem[], idx: number[], size: number): Piece[] {
  const segs: Piece[] = [];
  for (const i of idx) {
    const it = items[i]!;
    const x0 = it.transform[4] ?? 0;
    const p = { x0, x1: x0 + (it.width || 0), y: it.transform[5] ?? 0, size, text: it.str.trim() };
    const last = segs[segs.length - 1];
    if (last && p.x0 - last.x1 < COLUMN_GAP * size) {
      const gap = p.x0 - last.x1;
      last.text = gap > size * 0.15 ? joinWrapped(last.text, p.text) : last.text + p.text;
      last.x1 = Math.max(last.x1, p.x1);
    } else segs.push(p);
  }
  return segs;
}

/** Visual lines of a page: items grouped by baseline, left to right; whitespace items left out. */
function visualLines(items: PdfItem[]): VLine[] {
  const idx = items
    .map((it, i) => ({ it, i }))
    .filter(
      ({ it }) =>
        typeof it.str === 'string' &&
        it.str.trim() &&
        Math.abs(it.transform[1] ?? 0) < 0.01 &&
        Math.abs(it.transform[2] ?? 0) < 0.01,
    )
    .map(({ it, i }) => ({
      i,
      y: it.transform[5] ?? 0,
      x: it.transform[4] ?? 0,
      size: Math.abs(it.transform[0] ?? 0) || it.height || 1,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; size: number; idx: { i: number; x: number }[] }[] = [];
  for (const e of idx) {
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(cur.y - e.y) <= Math.max(1, 0.3 * Math.min(cur.size, e.size))) {
      cur.idx.push(e);
      cur.size = Math.max(cur.size, e.size);
    } else lines.push({ y: e.y, size: e.size, idx: [e] });
  }
  return lines.map((l) => {
    const order = l.idx.sort((a, b) => a.x - b.x).map((e) => e.i);
    return { y: l.y, size: l.size, segs: piecesOf(items, order, l.size), items: order };
  });
}

/** Column intervals: stretches of x covered by pieces, split where a gap of COLUMN_GAP sizes runs through every line. */
function columnsOf(pieces: Piece[], size: number): [number, number][] {
  const iv = pieces.map((p) => [p.x0, p.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
  const cols: [number, number][] = [];
  for (const [a, b] of iv) {
    const last = cols[cols.length - 1];
    if (last && a - last[1] < COLUMN_GAP * size) last[1] = Math.max(last[1], b);
    else cols.push([a, b]);
  }
  return cols;
}

function columnOf(cols: [number, number][], p: Piece): number {
  const mid = (p.x0 + p.x1) / 2;
  let best = 0;
  let dist = Infinity;
  cols.forEach(([a, b], i) => {
    const d = mid < a ? a - mid : mid > b ? mid - b : 0;
    if (d < dist) [best, dist] = [i, d];
  });
  return best;
}

/**
 * True when a one-piece line belongs to the run: it starts in a column and either ends before the
 * next column begins (a wrapped cell wider than its column so far) or is narrow (a cell whose
 * column the header has not lined up with yet). A line in the first column must be both, as body
 * text after a table starts there too.
 */
function fitsColumn(cols: [number, number][], p: Piece, narrow: boolean): boolean {
  const c = cols.findIndex(([a], i) => p.x0 >= a - 1 && (i === cols.length - 1 || p.x0 < cols[i + 1]![0]));
  if (c < 0) return false;
  const endsBefore = c === cols.length - 1 || p.x1 <= cols[c + 1]![0] + 1;
  return c === 0 ? narrow && endsBefore : narrow || endsBefore;
}

/** A column of bullets or list marks only makes a list, not a table. */
function isMarkColumn(cells: string[]): boolean {
  const filled = cells.filter(Boolean);
  return filled.length > 0 && filled.every((c) => c.length <= 3 && !/[\p{L}\p{N}]/u.test(c));
}

/**
 * Builds the table from a run of lines: columns from the gaps that run through all its multi-piece
 * lines; rows from the anchor column, the one with the most separate cells (pieces stacked at
 * most STACK sizes apart are one cell), its leftmost on a tie; every other piece goes to the row
 * whose anchor is nearest by baseline, which holds for top-aligned and for vertically centred
 * cells. Null when the run is not a table: under two columns, under two data rows, or two columns
 * without a header.
 */
function buildTable(lines: VLine[], page: number): Omit<PdfTable, 'used'> | null {
  const size = Math.max(...lines.map((l) => l.size));
  const multi = lines.filter((l) => l.segs.length >= 2);
  if (multi.length < 2) return null;
  const cols = columnsOf(
    multi.flatMap((l) => l.segs),
    size,
  );
  if (cols.length < 2) return null;
  const pieces = lines.flatMap((l) => l.segs).map((p) => ({ p, col: columnOf(cols, p) }));
  // Separate cells per column, top to bottom.
  const cellsPerCol = cols.map((_, c) => {
    const ys = pieces.filter((e) => e.col === c).map((e) => e.p.y);
    const cells: number[][] = [];
    for (const y of ys.sort((a, b) => b - a)) {
      const cur = cells[cells.length - 1];
      if (cur && cur[cur.length - 1]! - y <= STACK * size) cur.push(y);
      else cells.push([y]);
    }
    return cells;
  });
  let anchor = 0;
  cellsPerCol.forEach((c, i) => {
    if (c.length > cellsPerCol[anchor]!.length) anchor = i;
  });
  const rowsY = cellsPerCol[anchor]!.map((ys) => ({ top: ys[0]!, mid: (ys[0]! + ys[ys.length - 1]!) / 2 }));
  if (rowsY.length < 2) return null;
  const nearest = (p: Piece) => {
    let best = 0;
    let dist = Infinity;
    rowsY.forEach((r, i) => {
      const d = Math.min(Math.abs(p.y - r.top), Math.abs(p.y - r.mid));
      if (d < dist) [best, dist] = [i, d];
    });
    return best;
  };
  // When (almost) no piece sits above its row's anchor, the cells are top-aligned: a piece then
  // belongs to the last row that starts at or above it, which keeps the third line of a tall cell
  // in its row. Vertically centred cells put the first line of every tall cell above the anchor.
  const above = pieces.filter(({ p }) => p.y > rowsY[nearest(p)]!.top + 0.5 * size).length;
  const topAligned = above <= 0.05 * pieces.length;
  const rowOf = (p: Piece) => {
    if (!topAligned) return nearest(p);
    let r = 0;
    rowsY.forEach((row, i) => {
      if (row.top >= p.y - 0.5 * size) r = i;
    });
    return r;
  };
  const grid: Piece[][][] = rowsY.map(() => cols.map(() => []));
  for (const { p, col } of pieces) grid[rowOf(p)]![col]!.push(p);
  const text = (ps: Piece[]) =>
    ps
      .sort((a, b) => b.y - a.y || a.x0 - b.x0)
      .reduce((s, p) => joinWrapped(s, p.text), '')
      .trim();
  const rows = grid.map((r) => r.map(text));
  if (cols.some((_, c) => isMarkColumn(rows.map((r) => r[c]!)))) return null;
  const header = looksLikeHeader(rows[0]!) ? rows[0]! : [];
  const data = (header.length ? rows.slice(1) : rows).filter((r) => r.some(Boolean));
  if (!data.length) return null;
  if (!header.length && (cols.length < 3 || data.length < 3)) return null;
  if (cols.length === 2 && data.length < 2) return null;
  // Lines of a wrapped paragraph set in boxes (a quadrant diagram) start in lower case where they
  // go on; table cells rarely do.
  const cells = data.flat().filter(Boolean);
  if (cells.filter((c) => /^\p{Ll}/u.test(c)).length >= 0.4 * cells.length) return null;
  // Fill-in forms and text set in gapped lines look like rows; their columns are running text. A
  // table keeps at most half of its columns for text (a definitions or remarks column).
  const proseCols = cols.filter((_, c) => {
    const filled = data.map((r) => r[c]!).filter(Boolean);
    return filled.length && filled.filter(isProse).length * 2 >= filled.length;
  }).length;
  if (proseCols * 2 > cols.length) return null;
  return {
    table: { title: '', header, rows: data.map((cells) => ({ cells, page })) },
    page,
    top: lines[0]!.y,
    bottom: lines[lines.length - 1]!.y,
    size,
  };
}

/**
 * Tables of one PDF page from text positions: a run of lines, each with two or more pieces set a
 * column gap apart, or with one narrow piece inside a column of the run (a wrapped cell), lines at
 * most ROW_GAP sizes apart, whose columns line up (buildTable). The caption is the line just
 * above, when it stands apart, is short, set no larger than the table and not a sentence.
 */
export function findPdfTables(items: PdfItem[], page: number): PdfTable[] {
  const lines = visualLines(items);
  if (!lines.length) return [];
  const left = Math.min(...lines.flatMap((l) => l.segs.map((s) => s.x0)));
  const right = Math.max(...lines.flatMap((l) => l.segs.map((s) => s.x1)));
  const width = Math.max(1, right - left);
  const tables: PdfTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.segs.length < 2) {
      i++;
      continue;
    }
    const run: VLine[] = [lines[i]!];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      const prev = run[run.length - 1]!;
      if (prev.y - l.y > ROW_GAP * Math.max(prev.size, l.size)) break;
      if (l.segs.length >= 2) {
        run.push(l);
        continue;
      }
      const seg = l.segs[0]!;
      const cols = columnsOf(
        run.filter((r) => r.segs.length >= 2).flatMap((r) => r.segs),
        l.size,
      );
      if (cols.length >= 2 && fitsColumn(cols, seg, seg.x1 - seg.x0 <= NARROW * width)) run.push(l);
      else break;
    }
    // A wrapped cell's line can come before the first multi-piece line (a header cell set on three lines).
    let k = i - 1;
    while (k >= 0) {
      const l = lines[k]!;
      const seg = l.segs[0]!;
      const cols = columnsOf(
        run.filter((r) => r.segs.length >= 2).flatMap((r) => r.segs),
        l.size,
      );
      if (
        l.segs.length === 1 &&
        l.y - run[0]!.y <= 1.5 * l.size &&
        cols.length >= 2 &&
        fitsColumn(cols, seg, seg.x1 - seg.x0 <= NARROW * width)
      ) {
        run.unshift(l);
        k--;
      } else break;
    }
    const built = buildTable(run, page);
    if (built) {
      const used = new Set(run.flatMap((l) => l.items));
      const above = lines[k];
      const aboveThat = lines[k - 1];
      if (
        above &&
        above.segs.length === 1 &&
        above.y - run[0]!.y <= 3.2 * built.size &&
        above.size <= built.size * 1.15 &&
        above.segs[0]!.text.length <= 120 &&
        !/[.。;；:：,，]$/u.test(above.segs[0]!.text) &&
        (!aboveThat || aboveThat.y - above.y >= 1.4 * above.size)
      ) {
        built.table.title = above.segs[0]!.text;
        for (const it of above.items) used.add(it);
      }
      tables.push({ ...built, used });
      i = j;
    } else i++;
  }
  return tables;
}

/** Whitespace items inside a table's lines carry no text; they go with the table too. */
export function itemsOutside(items: PdfItem[], t: PdfTable): boolean[] {
  return items.map((it, i) => {
    if (t.used.has(i)) return false;
    if (typeof it.str === 'string' && !it.str.trim()) {
      const y = it.transform[5] ?? 0;
      return !(y <= t.top + 0.3 * t.size && y >= t.bottom - 0.3 * t.size);
    }
    return true;
  });
}
