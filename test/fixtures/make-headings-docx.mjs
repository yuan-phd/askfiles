// Writes test/fixtures/headings.docx: every way Word marks a heading that the splitter must find
// (Session K, part 3.6): Title and Subtitle styles, Heading 4 to 6 with capitalized names, a style
// that only sets an outline level, a style based on Heading 2, a paragraph with its own outline
// level and no style (the Preamble case from the owner's test), and a sentence set in a heading
// style that the heading filter must turn back into body text.
// Run: node test/fixtures/make-headings-docx.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './make-eval-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** [pPr inner xml or '', text] per paragraph. */
const paragraphs = [
  ['<w:pStyle w:val="Title"/>', 'Club charter'],
  ['<w:pStyle w:val="Subtitle"/>', 'Adopted in 2026'],
  ['<w:outlineLvl w:val="0"/>', 'Preamble'],
  ['', 'We, the members, agree to these rules.'],
  ['<w:pStyle w:val="ChapterHead"/>', 'Article 1 Name'],
  ['', 'The club is called the Riverside Reading Club.'],
  ['<w:pStyle w:val="MyHeading2"/>', '1.1 Members'],
  ['', 'Anyone who lives in the district may join.'],
  ['<w:pStyle w:val="Heading3"/>', 'Members pay a yearly fee that the board sets every January.'],
  ['<w:pStyle w:val="Heading4"/>', 'Fees'],
  ['', 'The fee is 20 euros.'],
  ['<w:pStyle w:val="Heading5"/>', 'Reduced fee'],
  ['', 'Students pay half.'],
  ['<w:pStyle w:val="Heading6"/>', 'Proof'],
  ['', 'A student card is enough.'],
  ['<w:pStyle w:val="ZhHeading2"/>', '第二条 会议'],
  ['', '每月举行一次会议。'],
];

const style = (id, name, extra = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const styles = [
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>',
  style('Title', 'Title', '<w:basedOn w:val="Normal"/>'),
  style('Subtitle', 'Subtitle', '<w:basedOn w:val="Normal"/>'),
  style('Heading2', 'heading 2', '<w:basedOn w:val="Normal"/>'),
  style('Heading3', 'heading 3', '<w:basedOn w:val="Normal"/>'),
  style('Heading4', 'Heading 4', '<w:basedOn w:val="Normal"/>'),
  style('Heading5', 'Heading 5', '<w:basedOn w:val="Normal"/>'),
  style('Heading6', 'Heading 6', '<w:basedOn w:val="Normal"/>'),
  style('ChapterHead', 'Chapter Head', '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>'),
  style('MyHeading2', 'My Heading 2', '<w:basedOn w:val="Heading2"/>'),
  style('ZhHeading2', '标题 2', '<w:basedOn w:val="Normal"/>'),
].join('');

export function buildHeadingsDocx() {
  const body = paragraphs
    .map(
      ([ppr, text]) =>
        `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`,
    )
    .join('');
  return zip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ],
    ['word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>${styles}</w:styles>`],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ],
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(path.join(HERE, 'headings.docx'), buildHeadingsDocx());
}
