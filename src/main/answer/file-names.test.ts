import { describe, expect, it } from 'vitest';
import { displayName, rewriteFileNames } from '../browse/identifiers.js';
import { answer, DEFAULT_PARAMS, NO_RERANKER, type Retrieval, type RunSettings } from './index.js';
import { dropBacktickedFileNames, namePhrases, stripNames } from './file-names.js';
import { fileNameHeader, userMessage } from './prompt.js';
import type { AnswerSection } from './sections.js';

describe('displayName', () => {
  it('drops the sequence number and extension, keeps years and versions, drops derived-copy markers', () => {
    expect(displayName('01_Procurement_Regulations_2025.pdf')).toBe('Procurement Regulations 2025');
    expect(displayName('08_Contract_Management_Guidance.pdf')).toBe('Contract Management Guidance');
    expect(displayName('12_Request_for_Bids_Goods.docx')).toBe('Request for Bids Goods');
    expect(displayName('01_标准设备采购招标文件_2017年版.pdf')).toBe('标准设备采购招标文件 2017年版');
    expect(displayName('10_商品包装政府采购需求标准_试行.pdf')).toBe('商品包装政府采购需求标准 试行');
    expect(displayName('14_台式计算机采购指标摘录_衍生.xlsx')).toBe('台式计算机采购指标摘录');
    expect(displayName('15_政府采购信息发布管理办法_网页正文.txt')).toBe('政府采购信息发布管理办法');
    expect(displayName('Budget_Draft_v2.xlsx')).toBe('Budget v2');
    expect(displayName('Report  copy.docx')).toBe('Report');
  });

  it('falls back to the file name when nothing is left', () => {
    expect(displayName('01.pdf')).toBe('01.pdf');
  });
});

describe('rewriteFileNames', () => {
  const files = ['01_Procurement_Regulations_2025.pdf', '08_Contract_Management_Guidance.pdf', '1_Policy.pdf'];

  it('replaces whole file names with extension, in backticks or not', () => {
    expect(
      rewriteFileNames(
        'Compare `01_Procurement_Regulations_2025.pdf` and 08_Contract_Management_Guidance.pdf. When?',
        files,
      ),
    ).toBe('Compare Procurement Regulations 2025 and Contract Management Guidance. When?');
  });

  it('leaves names without extension, parts of longer tokens and other text alone', () => {
    const q = 'Does 01_Procurement_Regulations_2025 or x01_Procurement_Regulations_2025.pdf or 11_Policy.pdf say so?';
    expect(rewriteFileNames(q, files)).toBe(q);
  });
});

describe('sourceFileNames header', () => {
  it('is one line: [n] display name (file name) > heading path', () => {
    expect(
      fileNameHeader(
        {
          file: '01_标准设备采购招标文件_2017年版.pdf',
          display: '标准设备采购招标文件 2017年版',
          path: ['第二章', '2.4 招标文件的异议'],
        },
        1,
      ),
    ).toBe('[2] 标准设备采购招标文件 2017年版 (01_标准设备采购招标文件_2017年版.pdf) > 第二章 > 2.4 招标文件的异议');
    const m = userMessage('Q?', [{ path: ['A', 'B'], text: 'body', file: 'f.pdf', display: 'f' }], { fileNames: true });
    expect(m).toBe('Sources:\n\n[1] f (f.pdf) > A > B\nbody\n\nQuestion: Q?');
  });

  const section = (file: string, title: string, text: string, i: number): AnswerSection => ({
    key: `d${i}#1`,
    documentId: `d${i}`,
    file,
    relPath: file,
    url: file,
    sectionIndex: 1,
    title,
    path: ['Part', title],
    pageStart: 1,
    pageEnd: 1,
    pageLabel: null,
    text,
    fullLength: text.length,
  });
  const sections = [
    section(
      '01_Procurement_Regulations_2025.pdf',
      'Signing',
      'The contract is signed by the Borrower after approval.',
      1,
    ),
    section('08_Contract_Management_Guidance.pdf', 'Planning', 'The plan is completed when signing the contract.', 2),
  ];
  const r = {
    question: 'q',
    terms: [],
    vector: [],
    keyword: [],
    fused: [],
    candidates: sections,
    rerank: [null, null],
    bypass: true,
    bypassReason: 'reranker disabled',
    timings: { vectorMs: 0, keywordMs: 0, rerankMs: 0 },
  } as Retrieval;
  const sel = {
    selected: sections.map((x) => ({ section: x, rerank: null, trimmed: false })),
    dropped: [],
    budgetTokens: 6000,
    usedTokens: 100,
  };
  const settings = (o: Partial<typeof DEFAULT_PARAMS>): RunSettings => ({
    params: { ...DEFAULT_PARAMS, rerankerModel: NO_RERANKER, verifyCitations: true, ...o },
    scope: 'balanced',
    chatModel: 'm',
    contextLength: 8192,
    chunkMaxChars: 2000,
    temperature: 0.1,
  });
  const index = {
    identities: () =>
      sections.map((x) => ({ documentId: x.documentId, file: x.file, title: '', type: '', identifiers: [] })),
  } as never;

  async function run(o: Partial<typeof DEFAULT_PARAMS>, question: string, reply: string) {
    let user = '';
    let system = '';
    const result = await answer(question, r, sel, settings(o), {
      index,
      chat: async (c, on) => {
        system = c.messages[0]!.content;
        user = c.messages[1]!.content;
        on(reply);
        return { promptTokens: 1, completionTokens: 1 };
      },
    });
    return { user, system, result };
  }

  it('puts display name and file name in each header, keeps the rule against file names, verifies against the section text only', async () => {
    const q =
      'Compare `01_Procurement_Regulations_2025.pdf` and `08_Contract_Management_Guidance.pdf`. When is it signed?';
    // The sentence repeats only header words (file and display names): with the header in the
    // passage it would pass verification, against the section text it does not.
    const { user, system, result } = await run(
      { sourceFileNames: true },
      q,
      'Procurement Regulations 2025 Contract Management Guidance Regulations Guidance [1].',
    );
    expect(user).toContain('[1] Procurement Regulations 2025 (01_Procurement_Regulations_2025.pdf) > Part > Signing\n');
    expect(user).toContain(
      '[2] Contract Management Guidance (08_Contract_Management_Guidance.pdf) > Part > Planning\n',
    );
    expect(user).toContain(`Question: ${q}`);
    expect(system).toContain('Never write page numbers, file names or section names');
    expect(result.claims[0]!.unsupported).toBe(true);
    expect(result.cited.map((c) => c.passage)).toEqual([]);
  });

  it('questionFileNames rewrites the question the model reads only', async () => {
    const q =
      'Compare `01_Procurement_Regulations_2025.pdf` and `08_Contract_Management_Guidance.pdf`. When is it signed?';
    const { user } = await run({ questionFileNames: true }, q, 'Signed by the Borrower after approval [1].');
    expect(user).toContain(
      'Question: Compare Procurement Regulations 2025 and Contract Management Guidance. When is it signed?',
    );
    expect(user).toContain('[1] Part > Signing\n');
  });

  it('N2: display-only header, file names out of the answer, names out of the scored copy only', async () => {
    const q =
      'Compare `01_Procurement_Regulations_2025.pdf` and `08_Contract_Management_Guidance.pdf`. When is it signed?';
    const reply =
      'According to `01_Procurement_Regulations_2025.pdf`, the Procurement Regulations 2025 say it is signed by the Borrower after approval [1].';
    const { user, result } = await run(
      { sourceDisplayNames: true, questionFileNames: true, verifyStripNames: true, dropAnswerFileNames: true },
      q,
      reply,
    );
    expect(user).toContain('[1] Procurement Regulations 2025 > Part > Signing\n');
    expect(user).toContain(
      'Question: Compare Procurement Regulations 2025 and Contract Management Guidance. When is it signed?',
    );
    expect(result.rawText).toBe(reply);
    expect(result.fileNamesDropped).toBe(true);
    expect(result.namesStripped).toBe(1);
    expect(result.text).toBe(
      'According to, the Procurement Regulations 2025 say it is signed by the Borrower after approval [1].',
    );
    // The sentence shown keeps the display name; verification scored it without.
    expect(result.claims[0]!.text).toContain('Procurement Regulations 2025');
    expect(result.claims[0]!.citations).toEqual([1]);
  });

  it('leaves the prompt as before with both switches off', async () => {
    const q = 'When is `01_Procurement_Regulations_2025.pdf` signed?';
    const { user } = await run({}, q, 'Signed by the Borrower after approval [1].');
    expect(user).toBe(
      `Sources:\n\n[1] Part > Signing\n${sections[0]!.text}\n\n[2] Part > Planning\n${sections[1]!.text}\n\nQuestion: ${q}`,
    );
  });
});

describe('round N2 helpers', () => {
  it('sourceDisplayNames header is [n] display name > heading path', () => {
    const m = userMessage('Q?', [{ path: ['A', 'B'], text: 'body', file: 'f_x.pdf', display: 'f x' }], {
      displayNames: true,
    });
    expect(m).toBe('Sources:\n\n[1] f x > A > B\nbody\n\nQuestion: Q?');
  });

  it('drops backticked file names from answer text and tidies the gap, keeping display names', () => {
    expect(
      dropBacktickedFileNames(
        'In the Strategy Guidance (`06_Procurement_Strategy_Guidance.pdf`), objectives matter [5]. According to `01_Procurement_Regulations_2025.pdf`, it is signed [1].',
      ),
    ).toEqual({
      text: 'In the Strategy Guidance, objectives matter [5]. According to, it is signed [1].',
      changed: true,
    });
    expect(dropBacktickedFileNames('Procurement Regulations 2025 say so [1].')).toEqual({
      text: 'Procurement Regulations 2025 say so [1].',
      changed: false,
    });
  });

  it('strips whole display names and their 《》 forms only, never single words', () => {
    const phrases = namePhrases([
      'Procurement Regulations 2025',
      'Contract Management Guidance',
      '标准设备采购招标文件 2017年版',
    ]);
    expect(
      stripNames('The Procurement Regulations 2025 require a plan under the Contract Management Guidance.', phrases)
        .text,
    ).toBe('The require a plan under the.');
    // Parts of a name stay.
    expect(stripNames('The Procurement Regulations and the Guidance require it.', phrases)).toEqual({
      text: 'The Procurement Regulations and the Guidance require it.',
      changed: false,
    });
    expect(stripNames('《标准设备采购招标文件》规定异议应在投标截止时间10日前提出。', phrases).text).toBe(
      '规定异议应在投标截止时间10日前提出。',
    );
    expect(stripNames('依照`01_标准设备采购招标文件_2017年版.pdf`，采购招标须公开。', phrases).text).toBe(
      '依照，采购招标须公开。',
    );
  });
});
