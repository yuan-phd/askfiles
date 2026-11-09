// An invented two-page PDF whose one heading the splitter cuts into page parts: a large-font
// heading on page 1, then body text long enough (over three chunk maximums) to run onto page 2.
// Hand-written PDF objects, as test/fixtures/make-handbook-pdf.mjs, so no PDF library is needed.

function escapeText(s) {
  return s.replace(/[\\()]/g, (c) => '\\' + c);
}

function pageStream(lines) {
  const ops = ['BT', '72 740 Td'];
  for (const { text, size } of lines)
    ops.push(`/F1 ${size} Tf`, `${Math.round(size * 1.4)} TL`, `(${escapeText(text)}) Tj T*`);
  ops.push('ET');
  return ops.join('\n');
}

/** pages: [[{ text, size }, ...], ...]; returns the PDF bytes. */
export function buildPdf(pages) {
  const objects = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, i) => {
    const id = pageIds[i];
    const stream = pageStream(lines);
    objects[id] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const body = (page, n) =>
  Array.from({ length: n }, (_, i) => ({
    size: 10,
    text: `Page ${page} line ${i + 1}: notice is given in writing to the line manager, who confirms the last day.`,
  }));

/** A garden-club handbook: one heading, Notice period, cut by the splitter into a part per page. */
export function splitHeadingPdf() {
  return buildPdf([
    [{ text: 'Notice period', size: 18 }, ...body(1, 38)],
    [...body(2, 30), { text: 'Membership fees', size: 18 }, { text: 'Fees are paid once a year in spring.', size: 10 }],
  ]);
}
