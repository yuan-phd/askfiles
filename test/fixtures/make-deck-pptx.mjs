// Writes test/fixtures/deck.pptx: an invented PowerPoint deck with what the slide parser must handle
// (src/main/sections/pptx.ts): slides listed in presentation.xml in another order than their file
// names, a centre title and ordinary titles, bullets, a table, speaker notes, a slide number
// placeholder that only repeats the master, a slide with no text (a picture only), a slide without
// a title, Chinese text and XML entities.
// Run: node test/fixtures/make-deck-pptx.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './make-eval-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const para = (t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(t)}</a:t></a:r></a:p>`;
const shape = (ph, lines) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${lines.map(para).join('')}</p:txBody></p:sp>`;
const table = (rows) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${rows
    .map(
      (r) =>
        `<a:tr h="370840">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/>${para(c)}</a:txBody></a:tc>`).join('')}</a:tr>`,
    )
    .join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const picture =
  '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>';
const slide = (body) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
const notes = (lines) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${NS}><p:cSld><p:spTree>${shape('<p:ph type="sldImg"/>', [])}${shape('<p:ph type="body" idx="1"/>', lines)}${shape('<p:ph type="sldNum" idx="5"/>', ['3'])}</p:spTree></p:cSld></p:notes>`;
const rels = (list) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;

// File names on purpose out of deck order: slide3.xml is the deck's first slide.
const slides = {
  'slide3.xml': slide(
    shape('<p:ph type="ctrTitle"/>', ['Garden club plan 2027']) +
      shape('<p:ph type="subTitle" idx="1"/>', ['Invented for tests']),
  ),
  'slide1.xml': slide(
    shape('<p:ph type="title"/>', ['Budget & members']) +
      shape('<p:ph idx="1"/>', ['Fees stay at 20 euros.', 'Students pay half.']) +
      table([
        ['Item', 'Cost'],
        ['Seeds', '120'],
        ['Tools', '300'],
      ]) +
      shape('<p:ph type="sldNum" idx="12"/>', ['2']),
  ),
  'slide2.xml': slide(picture),
  'slide4.xml': slide(shape('<p:ph type="title"/>', ['会议安排']) + shape('<p:ph idx="1"/>', ['每月第一个周六开会。'])),
  'slide5.xml': slide(shape('', ['A text box with no title above it.'])),
};
const order = ['slide3.xml', 'slide1.xml', 'slide2.xml', 'slide4.xml', 'slide5.xml'];

export function buildDeckPptx() {
  const entries = [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${Object.keys(
        slides,
      )
        .map(
          (s) =>
            `<Override PartName="/ppt/slides/${s}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
        )
        .join('')}</Types>`,
    ],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    [
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldIdLst>${order
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`)
        .join('')}</p:sldIdLst></p:presentation>`,
    ],
    ['ppt/_rels/presentation.xml.rels', rels(order.map((s, i) => [`rId${10 + i}`, 'slide', `slides/${s}`]))],
    ...Object.entries(slides).map(([name, xml]) => [`ppt/slides/${name}`, xml]),
    ['ppt/slides/_rels/slide1.xml.rels', rels([['rId2', 'notesSlide', '../notesSlides/notesSlide1.xml']])],
    ['ppt/notesSlides/notesSlide1.xml', notes(['Ask the treasurer about the tools.'])],
  ];
  return zip(entries);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(path.join(HERE, 'deck.pptx'), buildDeckPptx());
  console.log('wrote deck.pptx');
}
