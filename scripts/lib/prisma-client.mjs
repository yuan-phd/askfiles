// Checks that upstream/server's generated Prisma client was built from its current schema.
// Usage: node scripts/lib/prisma-client.mjs check <serverDir>
//        node scripts/lib/prisma-client.mjs ensure <serverDir>   (npm run dev: regenerates a stale client)
//
// Why: prisma generate copies prisma/schema.prisma into node_modules/.prisma/client, and the client
// opens the database the copy names. A generate run while upstream/ is restored (git checkout --
// upstream, or yarn install's postinstall) bakes in upstream's hard-coded file:../storage/ path in
// place of patch 002's env("DATABASE_URL"); the server then opens an empty database inside the
// server code, rejects the stored API key and the dev app cannot finish onboarding. build.sh's
// build stamp does not see it, since the patched sources hash the same as before.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The url line of the datasource block, or null. */
export function datasourceUrl(schema) {
  const block = /datasource\s+\w+\s*\{([^}]*)\}/.exec(schema.replace(/^\s*\/\/.*$/gm, ''));
  const url = block && /^\s*url\s*=\s*(.+?)\s*$/m.exec(block[1]);
  return url ? url[1] : null;
}

/** { ok: true } when the generated client's schema equals prisma/schema.prisma, else a reason. */
export function checkClient(serverDir) {
  const read = (rel) => {
    try {
      return readFileSync(join(serverDir, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const source = read('prisma/schema.prisma');
  const generated = read('node_modules/.prisma/client/schema.prisma');
  if (source === null) return { ok: false, reason: 'prisma/schema.prisma is missing' };
  if (generated === null)
    return { ok: false, reason: 'node_modules/.prisma/client has no schema.prisma; run prisma generate' };
  if (generated === source) return { ok: true };
  const [s, g] = [datasourceUrl(source), datasourceUrl(generated)];
  return {
    ok: false,
    reason:
      s !== g
        ? `the generated client reads the database from ${g}, the schema from ${s}; it was generated without the patches`
        : 'the generated client was built from another version of prisma/schema.prisma',
  };
}

/** Runs the server's own prisma generate under this Node, from the patched schema; true when it exits 0. */
export function prismaGenerate(serverDir) {
  const r = spawnSync(
    process.execPath,
    [join(serverDir, 'node_modules/prisma/build/index.js'), 'generate', '--schema', 'prisma/schema.prisma'],
    {
      cwd: serverDir,
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    },
  );
  // Prisma's own output only when it fails, so a successful run adds no lines to npm run dev.
  if (r.status !== 0) process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status === 0;
}

/**
 * npm run dev: a client that does not match the patched schema is generated again (one line says
 * so) and checked once more; { ok: false } only when it still does not match. generate is injected
 * for the tests.
 */
export function ensureClient(serverDir, generate = prismaGenerate, log = console.log) {
  const first = checkClient(serverDir);
  if (first.ok) return { ok: true, regenerated: false };
  log(`[prisma-client] ${first.reason}; generating it again from prisma/schema.prisma`);
  const ran = generate(serverDir);
  const again = checkClient(serverDir);
  if (again.ok) return { ok: true, regenerated: true };
  return {
    ok: false,
    regenerated: true,
    reason: ran ? `still does not match after prisma generate: ${again.reason}` : 'prisma generate failed',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, dir] = process.argv.slice(2);
  if ((cmd !== 'check' && cmd !== 'ensure') || !dir) {
    console.error('usage: node scripts/lib/prisma-client.mjs check|ensure <serverDir>');
    process.exit(2);
  }
  const r = cmd === 'ensure' ? ensureClient(resolve(dir)) : checkClient(resolve(dir));
  if (r.ok) console.log('[prisma-client] generated client matches prisma/schema.prisma');
  else {
    console.error(`[prisma-client] ${r.reason}`);
    process.exit(1);
  }
}
