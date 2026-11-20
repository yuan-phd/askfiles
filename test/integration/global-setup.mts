// Once per integration run: builds upstream-build/run, the patched copy of upstream/ the tests boot
// (scripts/build.sh, seconds when nothing changed), and afterwards fails the run when upstream/ is not
// as it was before, since nothing may write there.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JavaScript helper without type declarations
import { buildRunCopy, upstreamState } from '../../scripts/lib/upstream-copy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default function setup(): () => void {
  const before = upstreamState(ROOT) as string;
  // Without RUN_INTEGRATION every file skips, so there is nothing to build for.
  if (process.env.RUN_INTEGRATION === '1') buildRunCopy(ROOT);
  return () => {
    const after = upstreamState(ROOT) as string;
    if (after !== before) {
      throw new Error(
        `[integration] upstream/ changed during the run; nothing may write there.\n` +
          `git status --ignored upstream/ before:\n${before}\nafter:\n${after}`,
      );
    }
    console.log('[integration] upstream/ unchanged');
  };
}
