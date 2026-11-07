import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph } from './build.js';
import { checkProfile, cueType, detectedType, loadProfiles, profileFor } from './profiles.js';
import { doc, PROSE_TEXT, REGULATION_TEXT } from './__fixtures__/docs.js';

const DIR = path.resolve(import.meta.dirname, '../../../config/profiles');
const profiles = loadProfiles(DIR);
const legal = profileFor(profiles, 'legal-finance');
const team = profileFor(profiles, 'team-work');
const general = profileFor(profiles, 'general');

describe('profiles', () => {
  it('ships legal-finance, team-work and general with the types and edges of the brief', () => {
    expect(profiles.map((p) => p.id).sort()).toEqual(['general', 'legal-finance', 'team-work']);
    expect(legal.types.map((t) => t.name)).toEqual([
      'regulation',
      'guidance',
      'template',
      'contract',
      'record',
      'data',
      'other',
    ]);
    expect(team.types.map((t) => t.name)).toEqual(['meeting', 'report', 'ticket', 'spec', 'other']);
    expect(general.types.map((t) => t.name)).toEqual(['book', 'article', 'note', 'reference']);
    const on = (p: typeof legal) =>
      Object.entries(p.edges)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort();
    expect(on(legal)).toEqual(['clauseReferences', 'headings', 'references', 'versions']);
    expect(on(team)).toEqual(['dates', 'projects', 'references', 'tickets']);
    expect(on(general)).toEqual(['references', 'related']);
    for (const p of profiles) for (const t of p.types) expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('falls back to the default profile for an unknown id', () => {
    expect(profileFor(profiles, 'gone').id).toBe('legal-finance');
    expect(profileFor(profiles, undefined).id).toBe('legal-finance');
  });

  it('refuses a broken profile with the reason', () => {
    const ok = JSON.parse(JSON.stringify(legal));
    expect(() => checkProfile({ ...ok, kinds: { ...ok.kinds, data: 'nope' } }, 'x.json')).toThrow(
      'x.json: kinds.data must name one of the types',
    );
    expect(() => checkProfile({ ...ok, bands: ['regulation', 'ghost'] })).toThrow(
      'bands: ghost is not one of the types',
    );
    expect(() => checkProfile({ ...ok, edges: { ...ok.edges, magic: true } })).toThrow(
      'edges.magic is not an edge rule',
    );
    expect(() => checkProfile({ ...ok, types: [{ name: 'Bad Name', color: '#000000' }] })).toThrow('types[0].name');
  });

  it('takes the cue that ends last in the title, so the head noun wins', () => {
    expect(cueType(legal, '08_Building_Management_Guidance.pdf')).toBe('guidance');
    expect(cueType(legal, '08_报销申报违规行为记录公告暂行办法.pdf')).toBe('regulation');
    expect(cueType(legal, '01_标准办公用品招标文件_2017年版.pdf')).toBe('template');
    expect(cueType(legal, 'Leave policy v2.md')).toBe('regulation');
    expect(cueType(legal, 'Supply contracts.docx')).toBe('contract');
    // A whole word only: contractor is not a contract.
    expect(cueType(legal, 'Contractor list.pdf')).toBeNull();
    expect(cueType(team, 'Billing standup 2026-03-04.md')).toBe('meeting');
  });

  it('keeps a spreadsheet as data and makes a long explanatory text a book in general', () => {
    expect(detectedType(legal, 'Contract price adjustment.xlsm', 'data')).toBe('data');
    expect(detectedType(legal, 'Contract template.xlsx', 'template')).toBe('data');
    expect(detectedType(general, 'Collected writing.pdf', 'explanatory', 30_000)).toBe('book');
    expect(detectedType(general, 'Collected writing.pdf', 'explanatory', 3_000)).toBe('article');
    // A title cue wins over the length: essays are articles.
    expect(detectedType(general, 'Essays.pdf', 'explanatory', 30_000)).toBe('article');
    expect(detectedType(legal, 'Thing.pdf', 'other')).toBe('other');
  });

  it('applies a per-document override that detection never replaces, and ignores one for a missing type', () => {
    const reg = doc('Rules.pdf', [['Scope', REGULATION_TEXT.repeat(3)]]);
    const prose = doc('Notes.pdf', [['Why', `${PROSE_TEXT}\n\n${PROSE_TEXT}`]]);
    const g = buildGraph([reg, prose], { profile: legal, overrides: { [reg.id]: 'contract', [prose.id]: 'meeting' } });
    const byTitle = Object.fromEntries(g.nodes.map((n) => [n.title, n]));
    expect(byTitle['Rules.pdf']).toMatchObject({ type: 'contract', detectedType: 'regulation', overridden: true });
    // meeting is not a legal-finance type: the detected type stands.
    expect(byTitle['Notes.pdf']).toMatchObject({ type: 'guidance', overridden: false });
    // Another profile recomputes the types from the same index.
    const t = buildGraph([reg, prose], { profile: team });
    expect(t.nodes.map((n) => n.type).sort()).toEqual(['report', 'spec']);
  });
});
