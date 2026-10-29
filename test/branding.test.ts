// No upstream product name anywhere a user can see it (docs/sessions/H-app-wiring.md, Added):
// the packaged pages and main process (src/), the files packed next to them (config/,
// package.json), the build scripts, and the window title. Exempt by design: upstream/ itself,
// THIRD-PARTY-NOTICES and its generator, and the About page, which credit the project as its MIT
// license asks; and the upstream repository URL the vendoring script fetches from.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WINDOW_TITLE } from '../src/main/app-mode.js';
import { messagePage, STARTING_PAGE } from '../src/main/message-page.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const NAME = /anything[\s_-]?llm/i;
// Environment variable names defined by our own patches (ANYTHING_LLM_BIND_HOST and so on) are
// identifiers a user never sees, not the product name.
const ENV_NAME = /\bANYTHING_LLM_[A-Z_]*/g;

const EXEMPT = new Set(['src/renderer/about/index.html', 'scripts/third-party-notices.mjs', 'THIRD-PARTY-NOTICES']);
const EXEMPT_LINE = [/https:\/\/github\.com\/Mintplex-Labs\/anything-llm\.git/];

function filesUnder(rel: string): string[] {
  const dir = path.join(ROOT, rel);
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => path.join(rel, f))
    .filter((f) => fs.statSync(path.join(ROOT, f)).isFile());
}

function matches(rel: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !EXEMPT_LINE.some((re) => re.test(line)))
    .filter(({ line }) => NAME.test(line.replace(ENV_NAME, '')))
    .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`);
}

describe('no upstream branding', () => {
  it('in src/, config/, scripts/ and package.json, apart from the About page and the notices', () => {
    const files = [...filesUnder('src'), ...filesUnder('config'), ...filesUnder('scripts'), 'package.json'].filter(
      (f) => !EXEMPT.has(f.split(path.sep).join('/')),
    );
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(matches)).toEqual([]);
  });

  it('the scan would catch the name', () => {
    expect(NAME.test('Powered by AnythingLLM')).toBe(true);
    expect(NAME.test('anything-llm')).toBe(true);
    expect(NAME.test('the anythingllm.db file')).toBe(true);
    expect(NAME.test('ANYTHING_LLM_BIND_HOST'.replace(ENV_NAME, ''))).toBe(false);
  });

  it('in the window title and the pages the main process shows itself', () => {
    expect(WINDOW_TITLE).toBe('AskFiles');
    for (const page of [STARTING_PAGE, messagePage('x')]) {
      expect(decodeURIComponent(page)).toContain('<title>AskFiles</title>');
      expect(decodeURIComponent(page)).not.toMatch(NAME);
    }
    // Pages cannot change the title: the upstream interface behind the developer switch sets its own.
    expect(fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')).toMatch(
      /on\('page-title-updated', \(event\) => event\.preventDefault\(\)\)/,
    );
  });

  it('credits the upstream project on the About page and in THIRD-PARTY-NOTICES', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src/renderer/about/index.html'), 'utf8')).toMatch(/AnythingLLM.*MIT/s);
    expect(fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES'), 'utf8')).toMatch(/AnythingLLM/);
  });
});
