// Writes the evaluation fixtures test/fixtures/eval-s/corpus and test/fixtures/eval-l/corpus:
// Markdown, Word, Excel and PDF files built by hand (store-only zip, raw PDF objects) so the
// fixtures need no generator dependency and their text is known exactly.
// Run: node test/fixtures/make-eval-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- zip (store only)

function dosTime() {
  // Fixed timestamp (2026-01-01 00:00) so regenerating gives identical bytes.
  return { time: 0, date: ((2026 - 1980) << 9) | (1 << 5) | 1 };
}

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime();
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- docx

/**
 * blocks: ['h1', text] | ['p', text] | ['table', rows[][]]. headingName(n) is the style name
 * written into styles.xml, so a fixture can use Word's English names or Chinese ones.
 */
export function buildDocx(blocks, headingName) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const para = (text, style) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const body = blocks
    .map(([kind, v]) => {
      if (kind === 'p') return para(v);
      if (kind === 'table') {
        const rows = v.map((r) => `<w:tr>${r.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`).join('');
        return `<w:tbl>${rows}</w:tbl>`;
      }
      return para(v, `Heading${kind.slice(1)}`);
    })
    .join('');
  const styles = [1, 2, 3]
    .map(
      (n) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="${headingName(n)}"/><w:basedOn w:val="Normal"/></w:style>`,
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
    [
      'word/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${styles}</w:styles>`,
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ],
  ]);
}

// ---------------------------------------------------------------- xlsx

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** sheets: [{ name, rows: (string | number)[][] }]. Strings go to the shared string table. */
export function buildXlsx(sheets) {
  const strings = [];
  const sid = (s) => {
    let i = strings.indexOf(s);
    if (i === -1) i = strings.push(s) - 1;
    return i;
  };
  const sheetXml = sheets.map(({ rows }) => {
    const data = rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((v, ci) => {
              const ref = `${colName(ci)}${ri + 1}`;
              return typeof v === 'number'
                ? `<c r="${ref}"><v>${v}</v></c>`
                : `<c r="${ref}" t="s"><v>${sid(String(v))}</v></c>`;
            })
            .join('')}</row>`,
      )
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`;
  });
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zip([
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS} ${R}><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ...sheetXml.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x]),
    [
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${xml(s)}</t></si>`).join('')}</sst>`,
    ],
    [
      'xl/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${NS}><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`,
    ],
  ]);
}

// ---------------------------------------------------------------- pdf with bookmarks

const pdfText = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);

/**
 * pages: array of line lists; a line is [text, fontSize]. bookmarks: [{ title, page (1-based),
 * line (index on that page), children }]. Each bookmark points at the top of its line with /XYZ.
 */
export function buildPdf(pages, bookmarks) {
  const TOP = 740;
  const layout = pages.map((lines) => {
    let y = TOP;
    return lines.map(([text, size]) => {
      y -= size * 1.5;
      return { text, size, y };
    });
  });
  const objects = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  let next = 5 + pages.length * 2;
  const flat = [];
  const assign = (list, parent) => {
    const ids = list.map(() => next++);
    list.forEach((b, i) => {
      flat.push({ ...b, id: ids[i], parent, prev: ids[i - 1], next: ids[i + 1] });
      if (b.children?.length) flat[flat.length - 1].kids = assign(b.children, ids[i]);
    });
    return ids;
  };
  const top = assign(bookmarks, 4);
  const countAll = (list) => list.reduce((n, b) => n + 1 + countAll(b.children ?? []), 0);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[4] = `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top[top.length - 1]} 0 R /Count ${countAll(bookmarks)} >>`;
  layout.forEach((lines, i) => {
    const ops = ['BT'];
    for (const l of lines) ops.push(`/F1 ${l.size} Tf`, `1 0 0 1 72 ${l.y} Tm`, `(${pdfText(l.text)}) Tj`);
    ops.push('ET');
    const stream = ops.join('\n');
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  for (const b of flat) {
    const l = layout[b.page - 1][b.line];
    const parts = [
      `/Title (${pdfText(b.title)})`,
      `/Parent ${b.parent} 0 R`,
      `/Dest [${pageIds[b.page - 1]} 0 R /XYZ 0 ${l.y + l.size} 0]`,
    ];
    if (b.prev) parts.push(`/Prev ${b.prev} 0 R`);
    if (b.next) parts.push(`/Next ${b.next} 0 R`);
    if (b.kids) parts.push(`/First ${b.kids[0]} 0 R /Last ${b.kids[b.kids.length - 1]} 0 R /Count ${b.kids.length}`);
    objects[b.id] = `<< ${parts.join(' ')} >>`;
  }
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

// ---------------------------------------------------------------- corpus S

function leavePolicy(version, annual, sickDays, parentalWeeks) {
  return `# Northwind leave policy

Version ${version}. This policy applies to all permanent employees of Northwind.

## Annual leave

Permanent employees receive ${annual} days of paid annual leave per calendar year.
Leave is requested in the staff portal at least two weeks before the first day off.

## Sick leave

Employees who are ill notify their manager before 10:00 on the first day of absence.
A medical certificate is required from day ${sickDays} of an absence onwards.

## Parental leave

Each parent may take ${parentalWeeks} weeks of paid parental leave within the first year after a birth or adoption.
`;
}

const itPages = [
  [
    ['1 Accounts', 16],
    ['Every employee receives one account for email, chat and the staff portal.', 11],
    ['Passwords must be changed every 90 days and must have at least 14 characters.', 11],
    ['Two-factor authentication with the Northwind app is mandatory for all accounts.', 11],
    ['2 Laptops', 16],
    ['Laptops are replaced every 4 years or earlier when a repair would cost more than half of a new device.', 11],
  ],
  [
    ['2.1 Lost devices', 13],
    ['A lost or stolen laptop must be reported to it-help@northwind.example within 24 hours.', 11],
    ['The IT team then locks the device remotely and erases it when it next connects.', 11],
    ['3 Printing', 16],
    ['Printers on every floor accept jobs from the staff portal; colour printing needs a project code.', 11],
  ],
];
const itBookmarks = [
  { title: '1 Accounts', page: 1, line: 0 },
  { title: '2 Laptops', page: 1, line: 4, children: [{ title: '2.1 Lost devices', page: 2, line: 0 }] },
  { title: '3 Printing', page: 2, line: 3 },
];

const expenseDocx = [
  ['h1', '报销制度'],
  ['p', '本制度适用于诺斯温德公司全体员工的费用报销。'],
  ['h2', '1 适用范围'],
  ['p', '因公出差、客户招待和培训产生的费用均可按本制度报销。'],
  ['h2', '2 差旅报销'],
  ['p', '出差住宿费用按城市标准报销，超出部分由员工自行承担。'],
  [
    'table',
    [
      ['城市', '每晚住宿上限'],
      ['北京', '600元'],
      ['上海', '650元'],
      ['其他城市', '400元'],
    ],
  ],
  ['h2', '3 提交期限'],
  ['p', '报销申请须在费用发生后30天内通过财务系统提交，逾期不予受理。'],
];

const budgetSheets = [
  {
    name: 'Budget 2026',
    rows: [
      ['Department', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'],
      ['Engineering', 120000, 125000, 130000, 135000, 510000],
      ['Marketing', 40000, 60000, 45000, 55000, 200000],
      ['Human resources', 20000, 20000, 22000, 23000, 85000],
    ],
  },
  {
    name: 'Headcount',
    rows: [
      ['Department', 'Employees'],
      ['Engineering', 42],
      ['Marketing', 11],
      ['Human resources', 6],
    ],
  },
];

// ---------------------------------------------------------------- corpus L

const receiving = [
  'Goods arrive at the north gate between 06:00 and 14:00 on working days; deliveries outside these hours are refused unless the shift lead has confirmed them in writing the day before.',
  'The driver hands over the delivery note, and the receiving clerk checks the order number against the purchase order in the warehouse system before any pallet leaves the truck.',
  'Every pallet is inspected for visible damage, wet packaging and broken seals. Damaged pallets are photographed from two sides and the photos are attached to the receipt in the system.',
  'Cartons are counted per pallet, not per delivery, so that a short shipment can be traced to the exact pallet. Differences of more than two cartons are reported to purchasing on the same day.',
  'Pallets heavier than 850 kg must be unloaded with the forklift in bay 3, which is the only bay with a reinforced ramp; the hand pallet trucks in the other bays are rated for lighter loads only.',
  'Chilled goods are unloaded first and moved to the cold room within 20 minutes. The receiving clerk records the core temperature of one carton per pallet with the probe thermometer.',
  'Hazardous materials are accepted only with a valid safety data sheet. They are stored in the locked cage next to bay 1 until the safety officer has checked the labels and the packaging.',
  'Returned goods from customers are received at the same gate but are kept apart on the yellow floor area; they are never mixed with new stock until quality control has released them.',
  'At the end of each receipt the clerk prints pallet labels with the storage location suggested by the system and sticks them on the short side of each pallet, facing the aisle.',
  'Receipts are closed in the system before the end of the shift. Open receipts at shift change are handed over in person, with the delivery notes, to the clerk of the next shift.',
  'Once a month the warehouse manager samples ten closed receipts at random and compares them with the physical stock to check that counting and labelling follow this procedure.',
  'Seasonal peaks in November and December double the number of deliveries; during these weeks a second receiving clerk works from 10:00 to 18:00 and the gate stays open until 16:00.',
  'Deliveries from new suppliers are checked in full for the first three receipts: every carton is opened and compared with the item description before the supplier is moved to sampling.',
  'Pallets that are not wrapped tightly enough to be moved safely are rewrapped at the wrapping station before they enter the racks, and the supplier is told about it in the weekly report.',
  'Keys to the north gate are kept by the shift lead; the gate is locked whenever no clerk is present, even during short breaks, and the alarm is set at the end of the last shift.',
  'Questions about this procedure go to the warehouse manager; suggestions for changes are collected in the operations meeting on the first Monday of each month.',
];

const manualDocx = [
  ['h1', 'Operations manual 运营手册'],
  [
    'p',
    'This manual describes how the Northwind warehouse receives, stores and ships goods, and the safety rules that apply on site.',
  ],
  ['h2', '1 Warehouse'],
  ['h3', '1.1 Receiving goods'],
  ...receiving.map((t) => ['p', t]),
  ['h3', '1.2 Storage'],
  [
    'p',
    'Fast-moving items are stored in aisles A to C close to the packing tables. Slow-moving items go to aisles D to H.',
  ],
  ['p', 'Stock counts of aisles A to C happen every week; the other aisles are counted once per quarter.'],
  ['h2', '2 Shipping 发货'],
  ['h3', '2.1 国内发货'],
  ['p', '国内订单在下午3点前确认的，当天发货；之后确认的订单在下一个工作日发货。'],
  ['p', '大件货物由合作物流公司配送，一般在3至5个工作日内送达。'],
  ['h3', '2.2 International shipping'],
  [
    'p',
    'International orders ship on Tuesdays and Thursdays. Customs documents are prepared by the export desk at least one day before pickup.',
  ],
  ['h2', '3 Safety 安全'],
  ['h3', '3.1 Fire drills'],
  [
    'p',
    'Fire drills take place twice a year, in March and in September. The assembly point is the car park next to the south gate.',
  ],
  ['h3', '3.2 急救'],
  ['p', '每个班次至少安排两名持证急救员。急救箱放在每个装卸区和休息室，每月检查一次。'],
];

// ---------------------------------------------------------------- write

export function writeFixtures(root = HERE) {
  const s = path.join(root, 'eval-s', 'corpus');
  const l = path.join(root, 'eval-l', 'corpus');
  mkdirSync(s, { recursive: true });
  mkdirSync(l, { recursive: true });
  writeFileSync(path.join(s, 'leave-policy-v1.md'), leavePolicy(1, 25, 3, 12));
  writeFileSync(path.join(s, 'leave-policy-v2.md'), leavePolicy(2, 27, 2, 16));
  writeFileSync(path.join(s, 'it-handbook.pdf'), buildPdf(itPages, itBookmarks));
  // Chinese style names, as WPS writes them, to exercise the splitter's style map.
  writeFileSync(
    path.join(s, '报销制度.docx'),
    buildDocx(expenseDocx, (n) => `标题 ${n}`),
  );
  writeFileSync(path.join(s, 'budget-2026.xlsx'), buildXlsx(budgetSheets));
  writeFileSync(
    path.join(l, 'operations-manual.docx'),
    buildDocx(manualDocx, (n) => `heading ${n}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFixtures();
