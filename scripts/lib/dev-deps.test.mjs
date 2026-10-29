import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProductionInstall } from './dev-deps.mjs';

let dir;
function write(rel, value) {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'askfiles-devdeps-'));
  write('package.json', { dependencies: { express: '1' }, devDependencies: { eslint: '9', nodemon: '2' } });
  write('node_modules/express/package.json', {});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('checkProductionInstall', () => {
  it('detects a production install with no dev packages left', () => {
    write('node_modules/.yarn-integrity', { flags: ['production'] });
    expect(checkProductionInstall(dir)).toEqual({ production: true, devPresent: [] });
  });

  it('detects a full install and lists dev packages present', () => {
    write('node_modules/.yarn-integrity', { flags: [] });
    write('node_modules/nodemon/package.json', {});
    expect(checkProductionInstall(dir)).toEqual({ production: false, devPresent: ['nodemon'] });
  });

  it('treats a missing integrity file as not production', () => {
    expect(checkProductionInstall(dir).production).toBe(false);
  });
});
