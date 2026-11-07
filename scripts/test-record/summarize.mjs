// Summarizes the test records testers exported from the test build (docs/test-build.md).
//   node scripts/test-record/summarize.mjs <folder>     (or npm run test-record:summarize -- <folder>)
// Reads every .jsonl file in the folder (not its subfolders) and prints, as Markdown: every
// question, how each one refers to files, the questions that fired named-file detection, the
// outcomes and starred sentences, and the most used Browse pages. A line exported twice (two
// exports of one record) is counted once.
import fs from 'node:fs';
import path from 'node:path';

const EXTENSIONS = 'pdf|docx?|xlsx?|xlsm|xls|md|markdown|txt|csv|pptx?|rtf|odt|html?';
const FILE_NAME = new RegExp(`[^\\s"'“”‘’()（）《》]+\\.(?:${EXTENSIONS})\\b`, 'i');
const DOC_NOUNS =
  'guidance|guide|guidelines|handbook|manual|policy|policies|document|documents|doc|file|files|report|contract|' +
  'agreement|plan|standard|standards|regulation|regulations|rules|procedure|procedures|template|form|spreadsheet|' +
  'workbook|sheet|table|pdf|letter|notice|memo|framework|strategy|act|law|specification|spec|brochure|paper|slides|deck';
const DESCRIPTION_EN = new RegExp(
  `\\b(?:the|this|that|these|those|my|our|your)\\s+(?:[\\w-]+\\s+){0,3}(?:${DOC_NOUNS})\\b`,
  'i',
);
const DESCRIPTION_ZH =
  /(?:这份|那份|这个|那个|这些|该|本|此|上述)\s*(?:文件|文档|指南|指引|手册|规定|办法|合同|协议|报告|表格|表|制度|标准|通知|方案|条例|细则|规范)|《[^》]+》/;

export const REFERENCE_KINDS = ['file name', 'display name', 'description', 'none'];

const baseName = (f) => f.replace(/\.[^.]+$/, '');
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .replace(/^(?:the|a|an) /, '')
    .trim();

/**
 * How a question refers to files, the most specific way it uses: by file name (a name with an
 * extension), by display name (a name the source cards or Browse showed, without a leading "the"),
 * by file name again for a file's name without its extension, by description (the guidance,
 * 这份指南, a title in 《》 that is no known name), or none.
 */
export function referenceKind(question, names) {
  if (FILE_NAME.test(question)) return 'file name';
  const q = norm(question);
  const has = (list) => list.map(norm).some((n) => n.length >= 4 && q.includes(n));
  if (has([...names.displays])) return 'display name';
  if (has([...names.files].map(baseName))) return 'file name';
  if (DESCRIPTION_EN.test(question) || DESCRIPTION_ZH.test(question)) return 'description';
  return 'none';
}

/** How much a line holds: of two copies of one line, the fuller one (a full export) is kept. */
const richness = (l) =>
  (l.answer ? 2 : 0) + (l.cited?.length ? 1 : 0) + (l.document ? 1 : 0) + (l.file ? 1 : 0) + (l.section ? 1 : 0);

/** The lines of every export in dir, with the file each came from; damaged lines are skipped. */
export function readExports(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const exports = [];
  const lines = [];
  const seen = new Map();
  let skipped = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    let header = null;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let l;
      try {
        l = JSON.parse(raw);
      } catch {
        skipped++;
        continue;
      }
      if (l.type === 'export') {
        header = l;
        continue;
      }
      const key = JSON.stringify([l.type, l.time, l.question ?? l.page ?? l.action ?? l.kind ?? '']);
      const before = seen.get(key);
      if (before === undefined) {
        seen.set(key, lines.length);
        lines.push({ ...l, source: f });
      } else if (richness(l) > richness(lines[before])) lines[before] = { ...l, source: f };
    }
    exports.push({
      file: f,
      mode: header?.mode ?? 'unknown',
      app: header?.app ?? '-',
      platform: header?.platform ?? '-',
    });
  }
  lines.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return { exports, lines, skipped };
}

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
const count = (items) => {
  const m = new Map();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};

export function summarize(dir) {
  const { exports, lines, skipped } = readExports(dir);
  const questions = lines.filter((l) => l.type === 'question');
  const names = { files: new Set(), displays: new Set() };
  for (const q of questions) {
    for (const f of q.switches?.namedFiles?.files ?? []) names.files.add(f);
    for (const c of q.cited ?? []) {
      if (c.file) names.files.add(c.file);
      if (c.display) names.displays.add(c.display);
    }
  }
  for (const l of lines) {
    if (l.type === 'source' && l.file) names.files.add(l.file);
    if (l.type === 'browse' && l.document) names.displays.add(l.document);
  }
  const rows = questions.map((q) => ({ ...q, ref: referenceKind(q.question, names) }));

  const out = [];
  out.push('# Test record summary', '');
  out.push(`${exports.length} exported files, ${lines.length} lines, ${questions.length} questions.`);
  if (skipped) out.push(`${skipped} damaged lines skipped.`);
  out.push('', '| File | Mode | App | Platform |', '| --- | --- | --- | --- |');
  for (const e of exports) out.push(`| ${cell(e.file)} | ${e.mode} | ${e.app} | ${e.platform} |`);

  out.push('', '## Questions', '');
  out.push('| # | Time | Library | Outcome | Starred | Named files | Refers to files by | Question |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  rows.forEach((q, i) => {
    const named = q.switches?.namedFiles?.fired ? q.switches.namedFiles.files.join(', ') : '-';
    out.push(
      `| ${i + 1} | ${cell(q.time)} | ${cell(q.library)} | ${q.outcome} | ${q.starred ?? 0} | ${cell(named)} | ${q.ref} | ${cell(q.question)} |`,
    );
  });

  out.push('', '## How questions refer to files', '');
  out.push('| Refers by | Questions |', '| --- | --- |');
  for (const k of REFERENCE_KINDS) out.push(`| ${k} | ${rows.filter((q) => q.ref === k).length} |`);

  const named = rows.filter((q) => q.switches?.namedFiles?.fired);
  out.push('', `## Named-file detection fired (${named.length} of ${rows.length})`, '');
  if (named.length) {
    out.push('| # | Question | Files detected | Per-file quota | Judge rerank |', '| --- | --- | --- | --- | --- |');
    for (const q of named) {
      const quota = q.switches.perFileQuota?.fired ? `${q.switches.perFileQuota.sections} sections` : 'no';
      const judge = q.switches.judgeRerank?.fired
        ? `${q.switches.judgeRerank.files} files, ${q.switches.judgeRerank.ms} ms`
        : 'no';
      out.push(
        `| ${rows.indexOf(q) + 1} | ${cell(q.question)} | ${cell(q.switches.namedFiles.files.join(', '))} | ${quota} | ${judge} |`,
      );
    }
  } else out.push('None.');
  const rewritten = rows.filter((q) => q.switches?.questionRewrite?.fired).length;
  out.push('', `Question rewrite fired on ${rewritten} of ${rows.length} questions.`);

  out.push('', '## Outcomes and starred sentences', '');
  const outcomes = count(rows.map((q) => q.outcome));
  out.push('| Outcome | Questions |', '| --- | --- |');
  for (const [o, n] of outcomes) out.push(`| ${o} | ${n} |`);
  const answers = rows.filter((q) => q.outcome === 'answer');
  const starred = answers.reduce((s, q) => s + (q.starred ?? 0), 0);
  const withStar = answers.filter((q) => (q.starred ?? 0) > 0).length;
  out.push('', `Refusals: ${rows.filter((q) => q.outcome === 'refusal').length}.`);
  out.push(`Starred sentences: ${starred} in ${withStar} of ${answers.length} answers.`);
  const times = rows
    .map((q) => q.totalMs)
    .filter((n) => typeof n === 'number')
    .sort((a, b) => a - b);
  if (times.length) out.push(`Median total time: ${(times[Math.floor((times.length - 1) / 2)] / 1000).toFixed(1)} s.`);

  const browse = lines.filter((l) => l.type === 'browse');
  out.push('', `## Browse pages (${browse.length} opened)`, '');
  out.push('| Page | Opened |', '| --- | --- |');
  for (const [p, n] of count(browse.map((b) => b.page))) out.push(`| ${p} | ${n} |`);
  const docs = count(browse.filter((b) => b.document).map((b) => b.document));
  if (docs.length) {
    out.push('', '| Document | Opened |', '| --- | --- |');
    for (const [d, n] of docs.slice(0, 15)) out.push(`| ${cell(d)} | ${n} |`);
  }

  const sources = lines.filter((l) => l.type === 'source');
  const adds = lines.filter((l) => l.type === 'add');
  out.push('', '## Other actions', '');
  out.push(
    `Source card clicks: ${sources.length} (${
      count(sources.map((s) => s.action))
        .map(([a, n]) => `${a} ${n}`)
        .join(', ') || 'none'
    }).`,
  );
  out.push(
    `Adds: ${adds.length} (${adds.reduce((s, a) => s + (a.added ?? 0), 0)} files or folders added, ${adds.reduce((s, a) => s + (a.skipped ?? 0), 0)} skipped).`,
  );

  return {
    text: out.join('\n') + '\n',
    stats: {
      exports: exports.length,
      questions: rows.length,
      refs: Object.fromEntries(REFERENCE_KINDS.map((k) => [k, rows.filter((q) => q.ref === k).length])),
      named: named.length,
      refusals: rows.filter((q) => q.outcome === 'refusal').length,
      starred,
      browse: Object.fromEntries(count(browse.map((b) => b.page))),
    },
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'summarize.mjs') {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('usage: node scripts/test-record/summarize.mjs <folder with exported .jsonl files>');
    process.exit(2);
  }
  process.stdout.write(summarize(dir).text);
}
