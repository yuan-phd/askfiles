// Writes test/fixtures/scanned.pdf: two pages that are only JPEG images, no text layer, like a
// scanner's output, so per-page OCR can be checked for real page numbers (Session K).
// The images test/fixtures/scanned-page.jpg and scanned-page-2.jpg were rendered in the cloud
// container, the first with:
//   convert -size 1240x700 xc:white -font DejaVu-Sans -pointsize 44 -fill black \
//     -annotate +100+150 'Travel policy' -pointsize 34 \
//     -annotate +100+260 'Train journeys are booked in second class.' \
//     -annotate +100+330 'Flights need written approval from a director.' \
//     -annotate +100+400 'Hotel costs are refunded up to 120 euros a night.' \
//     -colorspace Gray -quality 70 scanned-page.jpg
// and the second the same way with the lines of SCANNED_TEXT_2.
// Built by hand like make-handbook-pdf.mjs, so the fixture needs no dependency.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCANNED_TEXT = [
  'Travel policy',
  'Train journeys are booked in second class.',
  'Flights need written approval from a director.',
  'Hotel costs are refunded up to 120 euros a night.',
];

export const SCANNED_TEXT_2 = [
  'Meals',
  'Lunch on a work trip is refunded up to 25 euros.',
  'Dinner is refunded up to 40 euros.',
  'Receipts must show the date and the restaurant.',
];

/** Width, height and components from the first start-of-frame marker of a baseline JPEG. */
function jpegSize(jpg) {
  let i = 2;
  while (i < jpg.length) {
    if (jpg[i] !== 0xff) throw new Error(`bad JPEG marker at ${i}`);
    const marker = jpg[i + 1];
    const len = jpg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: jpg.readUInt16BE(i + 5), width: jpg.readUInt16BE(i + 7), components: jpg[i + 9] };
    }
    i += 2 + len;
  }
  throw new Error('no start-of-frame marker');
}

/** One page per JPEG, each page only the image scaled to a 595 point wide page. */
export function buildScannedPdf(...jpgs) {
  // Objects: 1 catalog, 2 pages, then per page: page, image, content.
  const n = jpgs.length;
  const pageObj = (i) => 3 + i * 3;
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>'];
  objects.push(`<< /Type /Pages /Kids [${jpgs.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`);
  const images = new Map();
  jpgs.forEach((jpg, i) => {
    const { width, height, components } = jpegSize(jpg);
    const pageW = 595;
    const pageH = Math.round((pageW * height) / width);
    const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${pageObj(i) + 1} 0 R >> >> /Contents ${pageObj(i) + 2} 0 R >>`,
    );
    objects.push(null);
    images.set(pageObj(i) + 1, { jpg, width, height, components });
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let size = parts[0].length;
  const push = (b) => {
    parts.push(b);
    size += b.length;
  };
  for (let k = 1; k < objects.length; k++) {
    offsets[k] = size;
    const img = images.get(k);
    if (img) {
      const cs = img.components === 1 ? '/DeviceGray' : '/DeviceRGB';
      push(
        Buffer.from(
          `${k} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpg.length} >>\nstream\n`,
          'latin1',
        ),
      );
      push(img.jpg);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      push(Buffer.from(`${k} 0 obj\n${objects[k]}\nendobj\n`, 'latin1'));
    }
  }
  const xref = size;
  const rows = offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`);
  push(
    Buffer.from(
      `xref\n0 ${objects.length}\n0000000000 65535 f \n${rows.join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      'latin1',
    ),
  );
  return Buffer.concat(parts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const jpg = readFileSync(new URL('./scanned-page.jpg', import.meta.url));
  const jpg2 = readFileSync(new URL('./scanned-page-2.jpg', import.meta.url));
  const out = new URL('./scanned.pdf', import.meta.url);
  writeFileSync(out, buildScannedPdf(jpg, jpg2));
  console.log(`wrote ${fileURLToPath(out)}`);
}
