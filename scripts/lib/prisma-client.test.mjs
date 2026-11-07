import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkClient, datasourceUrl, ensureClient } from './prisma-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schema = (url) =>
  `generator client {\n  provider = "prisma-client-js"\n}\n\n// datasource db {\n//   url = "file:old.db"\n// }\ndatasource db {\n  provider = "sqlite"\n  url      = ${url}\n}\n`;
const PATCHED = schema('env("DATABASE_URL")');
const UPSTREAM = schema('"file:../storage/upstream.db"');

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
function server(source, generated) {
  dir = mkdtempSync(join(tmpdir(), 'askfiles-prisma-'));
  mkdirSync(join(dir, 'prisma'));
  writeFileSync(join(dir, 'prisma/schema.prisma'), source);
  if (generated !== null) {
    mkdirSync(join(dir, 'node_modules/.prisma/client'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/.prisma/client/schema.prisma'), generated);
  }
  return dir;
}

describe('prisma-client check', () => {
  it('reads the datasource url, ignoring commented blocks', () => {
    expect(datasourceUrl(PATCHED)).toBe('env("DATABASE_URL")');
    expect(datasourceUrl(UPSTREAM)).toBe('"file:../storage/upstream.db"');
  });

  it('accepts a client generated from the patched schema', () => {
    expect(checkClient(server(PATCHED, PATCHED))).toEqual({ ok: true });
  });

  it('rejects a client generated while upstream was restored, naming both database sources', () => {
    const r = checkClient(server(PATCHED, UPSTREAM));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('"file:../storage/upstream.db"');
    expect(r.reason).toContain('env("DATABASE_URL")');
    expect(r.reason).toContain('without the patches');
  });

  it('rejects a missing client and a client from another schema version', () => {
    expect(checkClient(server(PATCHED, null)).reason).toContain('run prisma generate');
    expect(checkClient(server(PATCHED, PATCHED + '\nmodel x {\n  id Int @id\n}\n')).reason).toContain(
      'another version',
    );
  });

  it('exits 1 from the command line on a mismatch', () => {
    const cli = (d) => spawnSync('node', [join(here, 'prisma-client.mjs'), 'check', d], { encoding: 'utf8' });
    expect(cli(server(PATCHED, PATCHED)).status).toBe(0);
    const bad = cli(server(PATCHED, UPSTREAM));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('[prisma-client]');
  });
});

describe('prisma-client ensure (npm run dev)', () => {
  const copy = (d) => {
    copyFileSync(join(d, 'prisma/schema.prisma'), join(d, 'node_modules/.prisma/client/schema.prisma'));
    return true;
  };

  it('leaves a matching client alone', () => {
    let called = 0;
    const r = ensureClient(
      server(PATCHED, PATCHED),
      () => ++called > 0,
      () => {},
    );
    expect(r).toEqual({ ok: true, regenerated: false });
    expect(called).toBe(0);
  });

  it('regenerates a stale client, says so in one line, and continues', () => {
    const lines = [];
    const r = ensureClient(server(PATCHED, UPSTREAM), copy, (l) => lines.push(l));
    expect(r).toEqual({ ok: true, regenerated: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[prisma-client\] .*without the patches; generating it again/);
  });

  it('stops when the client still does not match after regenerating', () => {
    const r = ensureClient(
      server(PATCHED, UPSTREAM),
      () => true,
      () => {},
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('still does not match');
    expect(
      ensureClient(
        server(PATCHED, UPSTREAM),
        () => false,
        () => {},
      ).reason,
    ).toBe('prisma generate failed');
  });

  it("runs the server's own prisma generate from the command line", () => {
    const d = server(PATCHED, UPSTREAM);
    // A stand-in for node_modules/prisma that copies the schema as generate does.
    mkdirSync(join(d, 'node_modules/prisma/build'), { recursive: true });
    writeFileSync(
      join(d, 'node_modules/prisma/build/index.js'),
      "require('fs').copyFileSync('prisma/schema.prisma', 'node_modules/.prisma/client/schema.prisma');\n",
    );
    const ok = spawnSync(process.execPath, [join(here, 'prisma-client.mjs'), 'ensure', d], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('generating it again');
    expect(checkClient(d)).toEqual({ ok: true });
    writeFileSync(join(d, 'node_modules/prisma/build/index.js'), 'process.exit(1);\n');
    writeFileSync(join(d, 'node_modules/.prisma/client/schema.prisma'), UPSTREAM);
    const bad = spawnSync(process.execPath, [join(here, 'prisma-client.mjs'), 'ensure', d], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('prisma generate failed');
  });
});
