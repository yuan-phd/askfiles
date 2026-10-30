import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collect,
  licenseOf,
  loadStandardTexts,
  render,
  standardLicenseIds,
  standardTextHeading,
} from './third-party-notices.mjs';

const NOTICES = path.resolve(import.meta.dirname, '..', 'THIRD-PARTY-NOTICES');

function pkg(dir, json, license) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json));
  if (license) fs.writeFileSync(path.join(dir, 'LICENSE'), license);
}

describe('third-party notices', () => {
  it('walks the production closure only, resolving nested copies like Node', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-notices-'));
    pkg(root, {
      name: 'app',
      dependencies: { a: '1' },
      optionalDependencies: { gone: '1' },
      devDependencies: { dev: '1' },
    });
    const nm = path.join(root, 'node_modules');
    pkg(path.join(nm, 'a'), { name: 'a', version: '1.0.0', license: 'MIT', dependencies: { b: '2' } }, 'MIT text A');
    pkg(path.join(nm, 'a', 'node_modules', 'b'), { name: 'b', version: '2.0.0', license: { type: 'ISC' } }, 'ISC text');
    pkg(path.join(nm, 'b'), { name: 'b', version: '1.0.0', license: 'ISC' }, 'ISC text');
    pkg(path.join(nm, 'dev'), { name: 'dev', version: '9.9.9', license: 'GPL-3.0' });

    const { packages, missing } = collect(root);
    expect([...packages.keys()].sort()).toEqual(['a@1.0.0', 'b@2.0.0']);
    expect(missing).toEqual([]);
    const text = render([{ label: 'shell', packages, missing }], 'UPSTREAM LICENSE');
    expect(text).toContain('- a@1.0.0  MIT  [shell]');
    expect(text).toContain('- b@2.0.0  ISC  [shell]');
    expect(text).toContain('UPSTREAM LICENSE');
    expect(text.match(/ISC text/g)).toHaveLength(1);
    expect(text).not.toContain('dev@');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the license field in its old shapes', () => {
    expect(licenseOf({ license: 'MIT' })).toBe('MIT');
    expect(licenseOf({ license: { type: 'BSD' } })).toBe('BSD');
    expect(licenseOf({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] })).toBe('MIT OR Apache-2.0');
    expect(licenseOf({})).toBe('UNKNOWN');
  });

  it('maps license fields to the bundled standard texts', () => {
    expect(standardLicenseIds('LGPL-3.0-or-later')).toEqual({ ids: ['LGPL-3.0'], unresolved: [] });
    expect(standardLicenseIds('(MIT OR Apache-2.0)')).toEqual({ ids: ['MIT', 'Apache-2.0'], unresolved: [] });
    expect(standardLicenseIds('MIT AND ISC').ids).toEqual(['MIT', 'ISC']);
    expect(standardLicenseIds('Apache 2.0').ids).toEqual(['Apache-2.0']);
    expect(standardLicenseIds('MIT/X11').ids).toEqual(['MIT']);
    expect(standardLicenseIds('UNKNOWN')).toEqual({ ids: [], unresolved: ['UNKNOWN'] });
    const texts = loadStandardTexts();
    for (const id of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'LGPL-3.0', 'MPL-2.0', 'CC0-1.0']) {
      expect(texts.get(id), id).toBeTruthy();
    }
    // LGPL-3.0 builds on the GPL-3.0, and section 4 asks for both texts with the work.
    expect(texts.get('LGPL-3.0')).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE[\s\S]*GNU GENERAL PUBLIC LICENSE/);
  });

  it('adds the standard text for packages without a license file', () => {
    const packages = new Map([
      ['vips@1.0.0', { name: 'vips', version: '1.0.0', license: 'LGPL-3.0-or-later', text: '' }],
      ['dual@1.0.0', { name: 'dual', version: '1.0.0', license: '(MIT OR Apache-2.0)', text: '' }],
      ['own@1.0.0', { name: 'own', version: '1.0.0', license: 'MIT', text: 'Own MIT text' }],
      ['bare@1.0.0', { name: 'bare', version: '1.0.0', license: 'UNKNOWN', text: '' }],
    ]);
    const texts = new Map([
      ['LGPL-3.0', 'LGPL TEXT'],
      ['MIT', 'MIT TEXT'],
      ['Apache-2.0', 'APACHE TEXT'],
    ]);
    const text = render([{ label: 'shell', packages, missing: [] }], 'UPSTREAM', texts);
    expect(text).toContain(
      `${standardTextHeading('LGPL-3.0')}\n\nThese packages ship no license file and name LGPL-3.0`,
    );
    expect(text).toContain('LGPL TEXT');
    expect(text).toContain('MIT TEXT');
    expect(text).toContain('APACHE TEXT');
    expect(text).toMatch(/name MIT in their package\.json: dual@1\.0\.0\./);
    expect(text).toContain('Own MIT text');
    expect(text).toContain('- bare@1.0.0 (UNKNOWN)');
    expect(text).not.toContain('- vips@1.0.0 (');
  });

  it('has a license text in THIRD-PARTY-NOTICES for every listed package that names a license', () => {
    const text = fs.readFileSync(NOTICES, 'utf8');
    const [list, texts] = text.split('\nLicense texts\n');
    const listed = [...list.matchAll(/^- (\S+@\S+) {2}(.+?) {2}\[/gm)].map((m) => ({ key: m[1], license: m[2] }));
    expect(listed.length).toBeGreaterThan(100);
    const covered = new Set();
    for (const m of texts.matchAll(/^=== Used by: (.+) ===$/gm)) for (const k of m[1].split(', ')) covered.add(k);
    for (const m of texts.matchAll(
      /^These packages ship no license file and name (\S+) in their package\.json: (.+)\.$/gm,
    )) {
      expect(texts, `standard text ${m[1]}`).toContain(standardTextHeading(m[1]));
      for (const k of m[2].split(', ')) covered.add(k);
    }
    const uncovered = listed.filter((p) => !covered.has(p.key));
    // Only packages whose package.json names no license may go without a text.
    expect(uncovered.filter((p) => standardLicenseIds(p.license).ids.length > 0)).toEqual([]);
    expect(uncovered.every((p) => p.license === 'UNKNOWN')).toBe(true);
  });
});
