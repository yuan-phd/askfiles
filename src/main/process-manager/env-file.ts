import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

export function randomSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}

export function renderServerEnv(v: { serverPort: number; collectorPort: number }): string {
  return [
    '# Written once by AskFiles on first run and never overwritten.',
    '# The ports record the first run only: the process manager allocates fresh ports at every',
    '# start and passes them as environment variables, which take precedence over this file.',
    `SERVER_PORT=${v.serverPort}`,
    `COLLECTOR_PORT=${v.collectorPort}`,
    `JWT_SECRET="${randomSecret()}"`,
    `SIG_KEY="${randomSecret()}"`,
    `SIG_SALT="${randomSecret()}"`,
    `DISABLE_TELEMETRY="true"`,
    '',
  ].join('\n');
}

/** Creates the file only if it does not exist. Returns true when it was created. */
export function ensureServerEnvFile(file: string, v: { serverPort: number; collectorPort: number }): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // wx fails if the file exists, so a concurrent or earlier writer is never overwritten.
    fs.writeFileSync(file, renderServerEnv(v), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

export function readEnvFile(file: string): Record<string, string> {
  return util.parseEnv(fs.readFileSync(file, 'utf8')) as Record<string, string>;
}
