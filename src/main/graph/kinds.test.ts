import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../sections/index.js';
import { detectKind, kindSignals, MIN_KIND_SCORE, pickKind, scoreKinds } from './kinds.js';
import { PROSE_TEXT, REGULATION_TEXT } from './__fixtures__/docs.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../../test/fixtures');

async function fixtureDoc(rel: string) {
  const parsed = await parseFile(path.join(FIXTURES, rel), { structuredTables: true, cjkHeadings: true });
  return {
    title: path.basename(rel),
    sections: parsed.sections.map((s) => ({ title: s.title, text: s.blocks.map((b) => b.text).join('\n\n') })),
  };
}

const text = (title: string, body: string) => ({ title, sections: [{ title, text: body }] });

describe('kind detection', () => {
  it('reads corpus S and L: data for the spreadsheet, normative for the rule texts', async () => {
    expect(detectKind(await fixtureDoc('eval-s/corpus/budget-2026.xlsx')).kind).toBe('data');
    // Chinese obligations (须在, 不予) in a 100-word policy.
    expect(detectKind(await fixtureDoc('eval-s/corpus/报销制度.docx')).kind).toBe('normative');
    // Passwords must be changed, a lost laptop must be reported: the handbook states rules.
    expect(detectKind(await fixtureDoc('eval-s/corpus/it-handbook.pdf')).kind).toBe('normative');
    const manual = detectKind(await fixtureDoc('eval-l/corpus/operations-manual.docx'));
    expect(manual.kind).toBe('normative');
    expect(manual.words).toBeGreaterThan(500);
  });

  it('gives other when nothing is strong enough: a short descriptive policy', async () => {
    const r = detectKind(await fixtureDoc('eval-s/corpus/leave-policy-v2.md'));
    expect(r.kind).toBe('other');
    expect(Math.max(...Object.values(r.scores))).toBeLessThan(MIN_KIND_SCORE);
  });

  it('tells regulation, guidance, template, record and data apart', () => {
    expect(detectKind(text('Maintenance Regulations.pdf', REGULATION_TEXT.repeat(3))).kind).toBe('normative');
    expect(detectKind(text('Value guidance.pdf', `${PROSE_TEXT}\n\n${PROSE_TEXT}\n\n${PROSE_TEXT}`)).kind).toBe(
      'explanatory',
    );
    const form = [
      'Supplier name: [insert name of supplier]',
      'Date: ____________',
      'Address: [insert address]',
      'Signature: ______________ (signature)',
      'Amount: [insert amount]',
      'Bank:',
      'Contact:',
    ].join('\n');
    expect(detectKind(text('Bid form.docx', form)).kind).toBe('template');
    const minutes = [
      'Meeting minutes 2026-03-04',
      'Attendees: Ann Lee, Bo Chen, Cy Diaz',
      'Agenda: budget, hiring',
      'Ann Lee: the budget is approved.',
      'Bo Chen: hiring starts in April.',
      'Action items: Ann to send the plan by 2026-03-11. Bo to post the role by 2026-03-18.',
      'Next meeting 2026-03-25 at 10:00.',
    ].join('\n');
    expect(detectKind(text('Team sync.md', minutes)).kind).toBe('record');
    const table = Array.from({ length: 12 }, (_, i) => `Item: ${i} | Cost: ${i * 10} | Owner: A`).join('\n');
    expect(detectKind(text('costs.pdf', table)).kind).toBe('data');
  });

  it('scores Chinese articles and obligations as normative', () => {
    const zh = Array.from(
      { length: 8 },
      (_, i) => `第${'一二三四五六七八'[i]}条 审核人应当按照本规定发布公示，不得限制或者排斥潜在申请人。`,
    ).join('\n');
    expect(detectKind(text('招标公告管理办法.pdf', zh)).kind).toBe('normative');
  });

  it('breaks a tie to other and keeps every score between 0 and 1', () => {
    expect(pickKind({ normative: 0.6, explanatory: 0.6, template: 0, record: 0, data: 0 })).toBe('other');
    expect(pickKind({ normative: 0.2, explanatory: 0.1, template: 0, record: 0, data: 0 })).toBe('other');
    const s = scoreKinds(kindSignals(text('x.md', `${REGULATION_TEXT}\n${PROSE_TEXT}`.repeat(20))));
    for (const v of Object.values(s)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  // The two private test corpora (English and Chinese), kept as browse files by the eval runs. They
  // are not in the repository, so this runs only where ASKFILES_EVAL_RUNS points at those runs.
  const runs = process.env.ASKFILES_EVAL_RUNS ?? '';
  const corpus = (run: string) => path.join(runs, run, 'browse');
  const haveOwnerCorpora = runs !== '' && fs.existsSync(corpus('a2-crossdoc-en')) && fs.existsSync(corpus('a1-zh'));
  it.skipIf(!haveOwnerCorpora)('matches the private test corpora (skipped unless ASKFILES_EVAL_RUNS is set)', () => {
    const kinds = (run: string) => {
      const out: Record<string, string> = {};
      for (const f of fs.readdirSync(corpus(run)).filter((n) => n.endsWith('.json') && n !== 'identifiers.json')) {
        const d = JSON.parse(fs.readFileSync(path.join(corpus(run), f), 'utf8'));
        out[d.title.slice(0, 2)] = detectKind(d).kind;
      }
      return out;
    };
    const en = kinds('a2-crossdoc-en');
    expect(en).toMatchObject({
      '01': 'normative',
      '07': 'explanatory',
      '10': 'template',
      '11': 'data',
      '12': 'template',
    });
    const zh = kinds('a1-zh');
    expect(zh).toMatchObject({ '01': 'template', '04': 'normative', '05': 'normative', '14': 'data' });
  });
});
