import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collect, licenseOf, render } from './third-party-notices.mjs';

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
});
