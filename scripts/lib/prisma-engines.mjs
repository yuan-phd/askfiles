// Finds Prisma engine files under a node_modules directory and removes those built for other platforms.
// Usage: node scripts/lib/prisma-engines.mjs <nodeModulesDir> [--keep <platform>]
// Without --keep it only lists what it found.
import { readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Prisma 5 places engines in these packages. Re-check after a Prisma upgrade in upstream/server.
export const ENGINE_DIRS = ['.prisma/client', '@prisma/engines', 'prisma'];

// libquery_engine-debian-openssl-3.0.x.so.node, libquery_engine-darwin-arm64.dylib.node,
// schema-engine-darwin-arm64, query_engine-windows.dll.node, query-engine-linux-musl.exe ...
const ENGINE_FILE =
  /^(libquery_engine|query_engine|query-engine|schema-engine|migration-engine|introspection-engine|prisma-fmt)-(.+?)(\.so\.node|\.dylib\.node|\.dll\.node|\.exe)?$/;

export function parseEngineFile(name) {
  const match = ENGINE_FILE.exec(name);
  if (!match) return null;
  const [, engine, platform] = match;
  const kind =
    engine === 'schema-engine' || engine === 'migration-engine'
      ? 'schema'
      : engine.includes('query')
        ? 'query'
        : 'other';
  return { engine, platform, kind };
}

/** Engine files directly inside the known Prisma directories. Missing directories are skipped. */
export function findEngineFiles(nodeModulesDir) {
  const found = [];
  for (const dir of ENGINE_DIRS) {
    const abs = join(nodeModulesDir, dir);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parsed = parseEngineFile(entry.name);
      if (parsed) found.push({ path: join(abs, entry.name), ...parsed });
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Removes every engine file whose platform is not `keep`. Refuses to remove anything when the kept
 * platform lacks a query engine (needed at runtime) or a schema engine (needed by prisma migrate
 * deploy), because pruning would then leave an app that cannot open its database.
 */
export function pruneEngines({ nodeModulesDir, keep, dryRun = false }) {
  const files = findEngineFiles(nodeModulesDir);
  const kept = files.filter((f) => f.platform === keep);
  const missing = ['query', 'schema'].filter((kind) => !kept.some((f) => f.kind === kind));
  if (missing.length > 0) {
    const present = [...new Set(files.map((f) => f.platform))].join(', ') || 'none';
    throw new Error(
      `no ${missing.join(' or ')} engine for ${keep} under ${nodeModulesDir} (found platforms: ${present}). ` +
        `Run the build on a ${keep} machine, or add "${keep}" to binaryTargets in schema.prisma through a patch.`,
    );
  }
  const removed = files.filter((f) => f.platform !== keep);
  if (!dryRun) for (const f of removed) rmSync(f.path, { force: true });
  return { kept, removed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const nodeModulesDir = args[0] && resolve(args[0]);
  const keepIndex = args.indexOf('--keep');
  const keep = keepIndex >= 0 ? args[keepIndex + 1] : undefined;
  if (!nodeModulesDir || (keepIndex >= 0 && !keep)) {
    console.error('usage: node scripts/lib/prisma-engines.mjs <nodeModulesDir> [--keep <platform>]');
    process.exit(2);
  }
  const rel = (p) => relative(nodeModulesDir, p);
  try {
    if (keep) {
      const { kept, removed } = pruneEngines({ nodeModulesDir, keep });
      for (const f of removed) console.log(`[build] removed prisma engine ${rel(f.path)}`);
      for (const f of kept) console.log(`[build] kept prisma engine ${rel(f.path)}`);
    } else {
      const files = findEngineFiles(nodeModulesDir);
      if (files.length === 0) console.log('[build] WARNING: no prisma engines found');
      for (const f of files) console.log(`[build] prisma engine ${rel(f.path)} (${f.platform})`);
    }
  } catch (err) {
    console.error(`[build] ERROR: ${err.message}`);
    process.exit(1);
  }
}
