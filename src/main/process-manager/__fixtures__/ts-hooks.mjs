// Resolve hook for ts-register.mjs: sources import ./x.js, as tsc expects, but before a build only
// x.ts exists, so a missing .js specifier falls back to the .ts file next to it.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const js = new URL(specifier, context.parentURL);
    const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (!existsSync(fileURLToPath(js)) && existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
}
