// Builds are distributed from workflow artifacts only: every electron-builder call of the package
// scripts passes --publish never, so CI never publishes implicitly (on a push to main that asked for
// a GitHub token and failed the test build, mac run #65).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The electron-builder commands in a shell text, one per call, continuation lines joined. */
function calls(text) {
  return text
    .replace(/\\\n\s*/g, ' ')
    .split(/&&|\n/)
    .filter((c) => /(^|\s)electron-builder\s/.test(c) && !c.trim().startsWith('#'));
}

describe('packaging never publishes', () => {
  it('passes --publish never on every electron-builder call of the package scripts', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    const found = Object.entries(scripts)
      .filter(([name]) => name.startsWith('package:'))
      .flatMap(([name, cmd]) => calls(cmd).map((c) => [name, c.trim()]));
    expect(found.length).toBe(3);
    expect(found.filter(([, c]) => !c.includes('--publish never'))).toEqual([]);
  });

  it('passes it on every call of the test build packaging too', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'package-test-build.sh'), 'utf8');
    expect(calls(sh).length).toBe(3);
    expect(sh).toMatch(/^COMMON=\(.*--publish never\)$/m);
    expect(calls(sh).every((c) => c.includes('"${COMMON[@]}"'))).toBe(true);
  });
});
