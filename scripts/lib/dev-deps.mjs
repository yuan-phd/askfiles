// Checks that a yarn package was installed for production: the integrity file records the production
// flag, and lists devDependencies that are still present at the top of node_modules.
// Usage: node scripts/lib/dev-deps.mjs <packageDir>
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkProductionInstall(packageDir) {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const integrityPath = join(packageDir, 'node_modules', '.yarn-integrity');
  let production = false;
  if (existsSync(integrityPath)) {
    const integrity = JSON.parse(readFileSync(integrityPath, 'utf8'));
    production = Array.isArray(integrity.flags) && integrity.flags.includes('production');
  }
  // A devDependency can also be a transitive production dependency, so presence alone is reported, not removed.
  const devPresent = Object.keys(pkg.devDependencies ?? {}).filter((name) =>
    existsSync(join(packageDir, 'node_modules', name, 'package.json')),
  );
  return { production, devPresent };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const packageDir = process.argv[2] && resolve(process.argv[2]);
  if (!packageDir) {
    console.error('usage: node scripts/lib/dev-deps.mjs <packageDir>');
    process.exit(2);
  }
  const { production, devPresent } = checkProductionInstall(packageDir);
  if (!production) {
    console.error(`[build] ERROR: ${packageDir}/node_modules was not installed with --production`);
    process.exit(1);
  }
  if (devPresent.length > 0) {
    console.log(`[build] devDependencies still present (pulled in by production packages): ${devPresent.join(', ')}`);
  } else {
    console.log(`[build] no devDependencies left in ${packageDir}/node_modules`);
  }
}
