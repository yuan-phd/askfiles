/**
 * Structural kind of a document (docs/graph.md, Kinds), from signals in its text only: no model.
 * Each kind gets a score from 0 to 1; the highest wins, a tie or a best score below MIN_KIND_SCORE
 * gives other. The profile of the library maps the kind to a type name (profiles.ts).
 *
 * The thresholds are fitted to corpus S and L in test/fixtures and to the synthetic record and
 * template fixtures in kinds.test.ts; the owner's corpora were not available to this session.
 */

export const DOCUMENT_KINDS = ['normative', 'explanatory', 'template', 'record', 'data', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type KindScores = Record<Exclude<DocumentKind, 'other'>, number>;

export interface KindResult {
  kind: DocumentKind;
  scores: KindScores;
  /** Words read (a CJK character counts two thirds), for the long rule of a profile. */
  words: number;
}

/** The parts of a browse document detection reads. */
export interface KindInput {
  title: string;
  sections: { title: string; text: string }[];
}

/** Below this the evidence for every kind is too thin: other. */
export const MIN_KIND_SCORE = 0.25;

/** Text read per document; enough for the signals, bounded for very long files. */
const MAX_CHARS = 200_000;

const DATA_EXTENSIONS = /\.(xlsx|xlsm|xls|csv)$/i;

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

/** Numbered articles and clauses at the start of a line (or a section title). */
const CLAUSE_LINE = [
  /^\s*第[一二三四五六七八九十百千零〇两\d]+条/,
  /^\s*(?:article|clause|rule)\s+\d+/i,
  /^\s*(?:section\s+)?\d+\.\d+(?:\.\d+)*\.?\s+\S/i,
  /^\s*[（(][一二三四五六七八九十\d]{1,3}[）)]\s*\S/,
  /^\s*[一二三四五六七八九十]{1,3}、\S/,
];

/** Obligation words: shall, must, 应当, 不得 and their kin. */
const MODALS_EN =
  /\b(?:shall|must|shall not|must not|may not|is (?:required|prohibited|not permitted) to|are (?:required|prohibited|not permitted) to)\b/gi;
const MODALS_ZH = /应当|不得|必须|禁止|严禁|须(?=[在于由经按向])|应予|不应|不予|不准|不允许/g;

/** Fill-in placeholders of a template. */
const PLACEHOLDERS = [
  /\[(?:insert|enter|name|date|title|address|amount|number|company|signature|●|•|\s*)[^\]\n]{0,40}\]/gi,
  /【\s*】|［\s*］|\[\s*]/g,
  /_{4,}/g,
  /\{\{[^}\n]{1,40}\}\}/g,
  /<(?:name|date|title|address|company|amount|insert)[^>\n]{0,30}>/gi,
  /\bX{3,}\b|×{3,}|…{2,}|\.{8,}(?=\s|$)/g,
  /（(?:盖章|签字|签名|填写)）|\((?:signature|stamp|seal)\)/gi,
];
/** A short label line with nothing after its colon: Name:, 日期： */
const EMPTY_FIELD = /^\s*[\p{L}\p{N} ]{1,30}[:：]\s*$/u;

/** Meeting minutes, logs and tickets. */
const RECORD_WORDS =
  /\b(?:attendees|participants|apologies|action items?|meeting minutes|minutes of|agenda|next meeting|note taker|assignee|reporter)\b/gi;
const RECORD_WORDS_ZH = /参会人员|出席|列席|会议纪要|会议记录|议程|行动项|记录人|主持人|决议|待办/g;
const DATE =
  /\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b|\b(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])\/(?:19|20)?\d{2}\b|(?:19|20)\d{2}年\d{1,2}月\d{1,2}日|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? (?:19|20)\d{2}\b/gi;
const SPEAKER = /^\s*(?:[A-Z][a-z]+(?: [A-Z][a-z]+)?|[一-鿿]{2,4})\s?[:：]\s+\S/u;
const TIMESTAMP = /\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g;
export const TICKET_ID = /\b(?!(?:UTF|ISO|SHA|MD|COVID|GB|CVE|RFC|IEC|EN)-)[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

const clamp = (v: number) => Math.max(0, Math.min(1, v));
/** Soft saturation: 0.63 at x = 1, 0.95 at x = 3; strong evidence for two kinds rarely ties. */
const sat = (x: number) => 1 - Math.exp(-Math.max(0, x));
const round = (v: number) => Math.round(v * 1000) / 1000;

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** The measured signals; exported for the tests and docs/graph.md. */
export interface KindSignals {
  /** Size in thousands of words, a CJK character counted as two thirds of a word. */
  kwords: number;
  clauses: number;
  modals: number;
  /** Share of the text in prose paragraphs (200+ characters, 80+ for CJK, lines of 100+, 40+ for CJK). */
  prose: number;
  placeholders: number;
  emptyFields: number;
  dates: number;
  speakers: number;
  recordWords: number;
  tickets: number;
  timestamps: number;
  /** Share of non-empty lines that are table rows (cells joined by |). */
  tableRows: number;
  dataFile: boolean;
}

export function kindSignals(doc: KindInput): KindSignals {
  let text = '';
  for (const s of doc.sections) {
    if (text.length > MAX_CHARS) break;
    text += `${s.title}\n${s.text}\n\n`;
  }
  text = text.slice(0, MAX_CHARS);
  const cjk = text.match(CJK)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  const kwords = Math.max(0.05, (latinWords + (cjk * 2) / 3) / 1000);
  const lines = text.split('\n');
  const filled = lines.filter((l) => l.trim());
  let clauses = 0;
  let speakers = 0;
  let emptyFields = 0;
  let rows = 0;
  for (const l of filled) {
    if (CLAUSE_LINE.some((re) => re.test(l))) clauses++;
    if (SPEAKER.test(l)) speakers++;
    if (EMPTY_FIELD.test(l)) emptyFields++;
    if ((l.match(/ \| /g)?.length ?? 0) >= 2) rows++;
  }
  let proseChars = 0;
  let allChars = 0;
  for (const p of text.split(/\n{2,}/)) {
    const t = p.trim();
    if (!t) continue;
    allChars += t.length;
    const isCjk = (t.match(CJK)?.length ?? 0) > t.length / 3;
    // Prose has long lines: a list of short lines (minutes, a form) is not a paragraph of prose.
    const perLine = t.length / (t.split('\n').length || 1);
    if (!t.includes(' | ') && t.length >= (isCjk ? 80 : 200) && perLine >= (isCjk ? 40 : 100)) proseChars += t.length;
  }
  return {
    kwords,
    clauses,
    modals: count(text, MODALS_EN) + count(text, MODALS_ZH),
    prose: allChars ? proseChars / allChars : 0,
    placeholders: PLACEHOLDERS.reduce((n, re) => n + count(text, re), 0),
    emptyFields,
    dates: count(text, DATE),
    speakers,
    recordWords: count(text, RECORD_WORDS) + count(text, RECORD_WORDS_ZH),
    tickets: count(text, TICKET_ID),
    timestamps: count(text, TIMESTAMP),
    tableRows: filled.length ? rows / filled.length : 0,
    dataFile: DATA_EXTENSIONS.test(doc.title),
  };
}

/**
 * Scores per kind from the signals. Densities are per thousand words, so a long manual and a
 * one-page policy are measured alike; each density is also scaled by a minimum count (3 hits for
 * full weight), so one stray must in a 100-word note does not make it normative:
 * - normative: numbered clauses (scale 5 per thousand words) and obligation words (scale 6 per
 *   thousand), half each; both are needed for a high score.
 * - explanatory: the prose share, lowered by clause and obligation density.
 * - template: placeholders and empty fields (scale 4 per thousand words).
 * - record: dates, speaker labels, record words (attendees, action items, 会议纪要), ticket ids and
 *   timestamps, each as a density.
 * A density d against its scale k counts as sat(d / k) = 1 - exp(-d / k).
 * - data: 1 for a spreadsheet or CSV, else the share of table-row lines.
 */
export function scoreKinds(s: KindSignals): KindScores {
  const per = (n: number) => n / s.kwords;
  const enough = (n: number) => clamp(n / 3);
  const c = sat(per(s.clauses) / 5) * enough(s.clauses);
  const m = sat(per(s.modals) / 6) * enough(s.modals);
  const fill = s.placeholders + s.emptyFields;
  const recordEvidence =
    0.3 * sat(per(s.dates) / 8) * enough(s.dates) +
    0.25 * sat(per(s.speakers) / 6) * enough(s.speakers) +
    0.35 * sat(per(s.recordWords) / 3) * enough(s.recordWords) +
    0.1 * sat(per(s.tickets + s.timestamps) / 4) * enough(s.tickets + s.timestamps);
  return {
    normative: round(0.5 * c + 0.5 * m),
    explanatory: round(s.prose * (1 - 0.6 * c) * (1 - 0.4 * m)),
    template: round(sat(per(fill) / 4) * enough(fill)),
    record: round(clamp(recordEvidence)),
    data: round(s.dataFile ? 1 : clamp(s.tableRows * 1.25)),
  };
}

/** The kind with the highest score; a tie or a weak best score is other. */
export function pickKind(scores: KindScores): DocumentKind {
  const ranked = (Object.entries(scores) as [DocumentKind, number][]).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < MIN_KIND_SCORE) return 'other';
  if (second && second[1] === best[1]) return 'other';
  return best[0];
}

export function detectKind(doc: KindInput): KindResult {
  const signals = kindSignals(doc);
  const scores = scoreKinds(signals);
  return { kind: pickKind(scores), scores, words: Math.round(signals.kwords * 1000) };
}
