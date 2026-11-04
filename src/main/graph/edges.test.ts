import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph } from './build.js';
import { edgeHeading, RELATED_PER_DOCUMENT } from './edges.js';
import { initialPositions } from './layout.js';
import { loadProfiles, profileFor } from './profiles.js';
import { doc } from './__fixtures__/docs.js';

const profiles = loadProfiles(path.resolve(import.meta.dirname, '../../../config/profiles'));
const legal = profileFor(profiles, 'legal-finance');
const team = profileFor(profiles, 'team-work');
const general = profileFor(profiles, 'general');

const edgesOf = (g: ReturnType<typeof buildGraph>, kind: string) => g.edges.filter((e) => e.kind === kind);

describe('edges', () => {
  it('links documents sharing two or more headings, weight the count, page parts counted once', () => {
    const a = doc('Regulations.pdf', [
      ['1. Scope', 'x'],
      ['2. Definitions', 'x'],
      ['Contract Management (page 1)', 'x'],
      ['Contract Management (page 2)', 'x'],
      ['第一章', 'x'],
    ]);
    const b = doc('Guidance.pdf', [
      ['Scope', 'y'],
      ['DEFINITIONS', 'y'],
      ['Contract Management', 'y'],
      ['第一章', 'y'],
    ]);
    const c = doc('Template.docx', [
      ['Scope', 'z'],
      ['Annex', 'z'],
    ]);
    const g = buildGraph([a, b, c], { profile: legal });
    const h = edgesOf(g, 'headings');
    expect(h).toHaveLength(1);
    expect(h[0]!.weight).toBe(3);
    expect(h[0]!.headings!.map((x) => x.key).sort()).toEqual(['contract management', 'definitions', 'scope']);
    expect(edgeHeading('第一章')).toBe('');
    // Shared headings are off in the general profile.
    expect(edgesOf(buildGraph([a, b], { profile: general }), 'headings')).toEqual([]);
  });

  it('finds explicit references by title, title marks and clause references, with the passage', () => {
    const regs = doc('01_Procurement_Regulations_2025.pdf', [['Scope', 'These Regulations apply to every Borrower.']]);
    const guide = doc('07_Value_for_Money_Guidance.pdf', [
      ['Intro', 'This note expands on the Procurement Regulations for its readers.'],
      ['Detail', 'As set out in paragraph 5.9 of the Regulations, the Borrower publishes a plan.'],
      ['Other', 'Nothing here.'],
    ]);
    const zhA = doc('04_必须招标的工程项目规定.pdf', [['第一条', '为了确定必须招标的工程项目，制定本规定。']]);
    const zhB = doc('07_必须招标的基础设施和公用事业项目范围规定.pdf', [
      ['第一条', '根据《中华人民共和国招标投标法》和《必须招标的工程 项目规定》，制定本规定。'],
    ]);
    const g = buildGraph([regs, guide, zhA, zhB], { profile: legal });
    const refs = edgesOf(g, 'reference');
    const en = refs.find((e) => [e.source, e.target].includes(guide.id))!;
    expect(en.weight).toBe(2);
    expect(en.passages!.map((p) => [p.documentId, p.sectionIndex])).toEqual([
      [guide.id, 1],
      [guide.id, 2],
    ]);
    expect(en.passages![1]!.snippet).toContain('paragraph 5.9 of the Regulations');
    const zh = refs.find((e) => [e.source, e.target].includes(zhB.id))!;
    expect([zh.source, zh.target].sort()).toEqual([zhA.id, zhB.id].sort());
    expect(zh.passages![0]!.documentId).toBe(zhB.id);
    // Without clause references (team-work), the bare word Regulations is not a mention.
    const t = edgesOf(buildGraph([regs, guide], { profile: team }), 'reference');
    expect(t[0]!.weight).toBe(1);
  });

  it('merges a pair that references both ways into one edge with the weights summed', () => {
    const a = doc('Procurement Policy.pdf', [['A', 'See the Procurement Directive for details.']]);
    const b = doc('Procurement Directive.pdf', [
      ['B', 'The Procurement Policy sets the principles.'],
      ['C', 'The Procurement Policy is reviewed yearly.'],
    ]);
    const refs = edgesOf(buildGraph([a, b], { profile: legal }), 'reference');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.weight).toBe(3);
    expect(new Set(refs[0]!.passages!.map((p) => p.documentId))).toEqual(new Set([a.id, b.id]));
  });

  it('chains the versions of a family by date and marks a format copy as the same issue', () => {
    const v24 = doc('Rules 2024.pdf', [['A', 'x']]);
    const v25 = doc('Rules 2025.pdf', [['A', 'y']]);
    const v25w = doc('Rules 2025.docx', [['A', 'y']]);
    const g = buildGraph([v25w, v24, v25], { profile: legal });
    const chain = edgesOf(g, 'version');
    expect(chain).toHaveLength(2);
    expect(chain.find((e) => [e.source, e.target].includes(v24.id))!.sameIssue).toBe(false);
    expect(chain.find((e) => !([e.source, e.target] as string[]).includes(v24.id))!.sameIssue).toBe(true);
    // A version pair is not also a reference: a copy names its own title.
    expect(edgesOf(g, 'reference')).toEqual([]);
  });

  it('relates documents in the general profile by shared rare terms, mutual best pairs only', () => {
    const words = (list: string[]) => list.map((w) => `${w}s appear here`).join('. ');
    const shared = ['quasar', 'nebula', 'pulsar', 'magnetar', 'blazar', 'redshift'];
    const docs = [
      doc('Stars one.md', [['A', words([...shared, 'comet'])]]),
      doc('Stars two.md', [['A', words([...shared, 'meteor'])]]),
      ...Array.from({ length: 18 }, (_, i) => doc(`Filler ${i}.md`, [['A', words([`filler${i}word`, 'common'])]])),
    ];
    const g = buildGraph(docs, { profile: general });
    const rel = edgesOf(g, 'related');
    expect(rel).toHaveLength(1);
    expect(rel[0]!.terms).toEqual(expect.arrayContaining(['nebulas', 'quasars']));
    expect(RELATED_PER_DOCUMENT).toBe(3);
    // Off in legal-finance.
    expect(edgesOf(buildGraph(docs, { profile: legal }), 'related')).toEqual([]);
  });

  it('links team work by project names in titles, ticket ids and adjacent dates', () => {
    const docs = [
      doc('Billing migration kickoff 2026-03-02.md', [['Notes', 'We start BILL-142 this week.']]),
      doc('Billing migration standup 2026-03-09.md', [['Notes', 'BILL-142 is blocked on review.']]),
      doc('Hiring plan.md', [['Notes', 'Nothing about billing.']]),
      doc('Office move.md', [['Notes', 'Boxes.']]),
      doc('Budget review.md', [['Notes', 'Numbers.']]),
    ];
    const g = buildGraph(docs, { profile: team });
    expect(edgesOf(g, 'project').map((e) => e.terms)).toEqual([['billing', 'migration']]);
    expect(edgesOf(g, 'ticket').map((e) => e.terms)).toEqual([['BILL-142']]);
    expect(edgesOf(g, 'date')).toHaveLength(1);
  });
});

describe('layout and build', () => {
  it('gives the same positions every time, within -1 to 1, bands top to bottom in order', () => {
    const nodes = [
      { id: 'b', type: 'guidance' },
      { id: 'a', type: 'regulation' },
      { id: 'c', type: 'record' },
    ];
    const p1 = initialPositions(nodes, legal.bands);
    const p2 = initialPositions([...nodes].reverse(), legal.bands);
    expect([...p1.entries()].sort()).toEqual([...p2.entries()].sort());
    for (const p of p1.values())
      for (const v of [p.organic.x, p.organic.y, p.layered.x, p.layered.y]) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    expect(p1.get('a')!.layered.y).toBeLessThan(p1.get('b')!.layered.y);
    expect(p1.get('b')!.layered.y).toBeLessThan(p1.get('c')!.layered.y);
  });

  it('builds the same graph from the same index', () => {
    const docs = [
      doc('A 2024.pdf', [
        ['Scope', 'x'],
        ['Terms', 'y'],
      ]),
      doc('A 2025.pdf', [
        ['Scope', 'x'],
        ['Terms', 'y'],
      ]),
    ];
    const at = () => new Date('2026-11-04T00:00:00Z');
    const strip = (g: ReturnType<typeof buildGraph>) => ({ ...g, buildMs: 0 });
    expect(strip(buildGraph(docs, { profile: legal, now: at }))).toEqual(
      strip(buildGraph([...docs].reverse(), { profile: legal, now: at })),
    );
  });
});
