import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findEngineFiles, parseEngineFile, pruneEngines } from './prisma-engines.mjs';

describe('parseEngineFile', () => {
  it.each([
    ['libquery_engine-debian-openssl-3.0.x.so.node', 'libquery_engine', 'debian-openssl-3.0.x', 'query'],
    ['libquery_engine-darwin-arm64.dylib.node', 'libquery_engine', 'darwin-arm64', 'query'],
    ['query_engine-windows.dll.node', 'query_engine', 'windows', 'query'],
    ['query-engine-linux-musl', 'query-engine', 'linux-musl', 'query'],
    ['schema-engine-darwin-arm64', 'schema-engine', 'darwin-arm64', 'schema'],
    ['schema-engine-windows.exe', 'schema-engine', 'windows', 'schema'],
    ['prisma-fmt-darwin', 'prisma-fmt', 'darwin', 'other'],
  ])('%s', (name, engine, platform, kind) => {
    expect(parseEngineFile(name)).toEqual({ engine, platform, kind });
  });

  it.each(['index.js', 'schema.prisma', 'package.json', 'libquery_engine'])('ignores %s', (name) => {
    expect(parseEngineFile(name)).toBeNull();
  });
});

let nm;
function touch(rel) {
  const path = join(nm, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  return path;
}

beforeEach(() => {
  nm = mkdtempSync(join(tmpdir(), 'askfiles-engines-'));
});
afterEach(() => rmSync(nm, { recursive: true, force: true }));

function fixture() {
  return {
    linuxClient: touch('.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node'),
    macClient: touch('.prisma/client/libquery_engine-darwin-arm64.dylib.node'),
    clientJs: touch('.prisma/client/index.js'),
    linuxSchema: touch('@prisma/engines/schema-engine-debian-openssl-3.0.x'),
    macSchema: touch('@prisma/engines/schema-engine-darwin-arm64'),
    macEngines: touch('@prisma/engines/libquery_engine-darwin-arm64.dylib.node'),
    intelCli: touch('prisma/libquery_engine-darwin.dylib.node'),
    nested: touch('prisma/build/libquery_engine-debian-openssl-3.0.x.so.node'),
    elsewhere: touch('other/libquery_engine-debian-openssl-3.0.x.so.node'),
  };
}

describe('findEngineFiles', () => {
  it('finds engines only directly inside the Prisma directories', () => {
    const f = fixture();
    expect(findEngineFiles(nm).map((e) => e.path)).toEqual(
      [f.linuxClient, f.macClient, f.linuxSchema, f.macEngines, f.macSchema, f.intelCli].sort(),
    );
  });

  it('returns nothing when Prisma is not installed', () => {
    expect(findEngineFiles(nm)).toEqual([]);
  });
});

describe('pruneEngines', () => {
  it('removes every engine not built for the kept platform and nothing else', () => {
    const f = fixture();
    const { kept, removed } = pruneEngines({ nodeModulesDir: nm, keep: 'darwin-arm64' });
    expect(removed.map((e) => e.path).sort()).toEqual([f.linuxClient, f.linuxSchema, f.intelCli].sort());
    expect(kept).toHaveLength(3);
    for (const p of [f.linuxClient, f.linuxSchema, f.intelCli]) expect(existsSync(p)).toBe(false);
    for (const p of [f.macClient, f.macSchema, f.macEngines, f.clientJs, f.nested, f.elsewhere]) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it('dry run reports without deleting', () => {
    const f = fixture();
    const { removed } = pruneEngines({ nodeModulesDir: nm, keep: 'darwin-arm64', dryRun: true });
    expect(removed).toHaveLength(3);
    expect(existsSync(f.linuxClient)).toBe(true);
  });

  it('refuses to prune when the kept platform has no query engine, and deletes nothing', () => {
    const linux = touch('.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node');
    touch('@prisma/engines/schema-engine-darwin-arm64');
    expect(() => pruneEngines({ nodeModulesDir: nm, keep: 'darwin-arm64' })).toThrow(
      /no query engine for darwin-arm64.*debian-openssl-3\.0\.x/,
    );
    expect(existsSync(linux)).toBe(true);
  });

  it('refuses to prune when the kept platform has no schema engine', () => {
    touch('.prisma/client/libquery_engine-darwin-arm64.dylib.node');
    const linuxSchema = touch('@prisma/engines/schema-engine-debian-openssl-3.0.x');
    expect(() => pruneEngines({ nodeModulesDir: nm, keep: 'darwin-arm64' })).toThrow(/no schema engine/);
    expect(existsSync(linuxSchema)).toBe(true);
  });
});
