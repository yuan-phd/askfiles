import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkClient, datasourceUrl } from './prisma-client.mjs';

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
