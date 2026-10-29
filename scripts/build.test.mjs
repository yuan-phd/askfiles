import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs a copy of build.sh in an empty fixture tree, so only the checks that come before step 1 run.
const here = dirname(fileURLToPath(import.meta.url));
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'askfiles-build-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(here, 'build.sh'), join(root, 'scripts/build.sh'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(env) {
  return spawnSync('bash', [join(root, 'scripts/build.sh')], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('build.sh preflight', () => {
  it('rejects an unknown PACKAGE_TARGET', () => {
    const result = run({ PACKAGE_TARGET: 'win-x64' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown PACKAGE_TARGET 'win-x64'");
    expect(result.stdout).not.toContain('1/7');
  });

  it('stops before building for mac-arm64 when resources/ollama is missing', () => {
    const result = run({ PACKAGE_TARGET: 'mac-arm64' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('resources/ollama/ollama is missing');
    expect(result.stdout).not.toContain('1/7');
  });

  it('fails with the patch step message when the tree has no patch helper', () => {
    const result = run({ PACKAGE_TARGET: '' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('1/7 apply patches');
    expect(result.stderr).toContain('patching upstream failed');
  });
});
