// Writes test/fixtures/labels.pdf: four text pages whose printed page labels differ from the page
// index (i, ii, then 1, 2), with nested bookmarks (1 Scope > 1.1 Terms), for the page label and
// heading path records of Session K. Built by hand like make-handbook-pdf.mjs.
// Run: node test/fixtures/make-labels-pdf.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGES = [
  ['Preface', 'This guide explains how the library lends books.'],
  ['The preface continues with thanks to the volunteers.'],
  ['1 Scope', 'The rules apply to every member of the library.'],
  ['1.1 Terms', 'A loan lasts three weeks and can be renewed twice.'],
];
// [title, page index from 0, line, level]
const MARKS = [
  ['Preface', 0, 0, 1],
  ['1 Scope', 2, 0, 1],
  ['1.1 Terms', 3, 0, 2],
];

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const lineY = (line) => 740 - line * 24;

export function buildLabelsPdf() {
  const objects = [];
  const pageIds = PAGES.map((_, i) => 5 + i * 2);
  const markIds = MARKS.map((_, i) => 5 + PAGES.length * 2 + i);
  objects[1] =
    '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageLabels << /Nums [0 << /S /r >> 2 << /S /D >>] >> >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${PAGES.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  // Top level: Preface and 1 Scope; 1.1 Terms is the child of 1 Scope.
  objects[4] = `<< /Type /Outlines /First ${markIds[0]} 0 R /Last ${markIds[1]} 0 R /Count 3 >>`;
  PAGES.forEach((lines, i) => {
    const ops = ['BT'];
    lines.forEach((t, k) =>
      ops.push(
        `/F1 ${k === 0 && MARKS.some((m) => m[1] === i) ? 16 : 11} Tf`,
        `1 0 0 1 72 ${lineY(k)} Tm`,
        `(${esc(t)}) Tj`,
      ),
    );
    ops.push('ET');
    const stream = ops.join('\n');
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  const dest = (m) => `/Dest [${pageIds[m[1]]} 0 R /XYZ 0 ${lineY(m[2]) + 16} 0]`;
  objects[markIds[0]] = `<< /Title (${esc(MARKS[0][0])}) /Parent 4 0 R /Next ${markIds[1]} 0 R ${dest(MARKS[0])} >>`;
  objects[markIds[1]] =
    `<< /Title (${esc(MARKS[1][0])}) /Parent 4 0 R /Prev ${markIds[0]} 0 R /First ${markIds[2]} 0 R /Last ${markIds[2]} 0 R /Count 1 ${dest(MARKS[1])} >>`;
  objects[markIds[2]] = `<< /Title (${esc(MARKS[2][0])}) /Parent ${markIds[1]} 0 R ${dest(MARKS[2])} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('./labels.pdf', import.meta.url), buildLabelsPdf());
}
