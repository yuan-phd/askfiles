import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;

export const PORT_ENV = 'ASKFILES_PORT';
export const CONFIG_ENV = 'ASKFILES_CONFIG';
export const LOG_DIR_ENV = 'ASKFILES_LOG_DIR';

export function parsePort(value: unknown, source: string): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  // Number('') is 0 and Number('1e3') is 1000, so require plain digits before converting.
  if (!/^\d+$/.test(text)) {
    throw new Error(`invalid port ${JSON.stringify(value)} from ${source}`);
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw new Error(`port ${port} from ${source} is outside 1-65535`);
  }
  return port;
}

export interface PortOptions {
  env: Env;
  defaultConfigPath: string;
  readFile?: (path: string) => string;
}

export interface ResolvedPort {
  port: number;
  source: string;
}

/**
 * The environment variable wins over the config file so a developer can point the shell at a
 * server started by hand. Returns null when neither is set; a set but invalid value throws,
 * because silently ignoring it would open the window on the wrong server.
 */
export function resolvePort(options: PortOptions): ResolvedPort | null {
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const fromEnv = options.env[PORT_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    return { port: parsePort(fromEnv, PORT_ENV), source: PORT_ENV };
  }

  const configPath = options.env[CONFIG_ENV] || options.defaultConfigPath;
  let raw: string;
  try {
    raw = readFile(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`config file ${configPath} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || !('port' in parsed)) return null;
  return { port: parsePort((parsed as { port: unknown }).port, configPath), source: configPath };
}

export function resolveLogDir(env: Env, defaultDir: string): string {
  return env[LOG_DIR_ENV] || defaultDir;
}

export type Logger = (message: string) => void;

/** One line per event with a stable prefix, written to <dir>/<name>.log and to stdout. */
export function createLogger(dir: string, name: string, now: () => Date = () => new Date()): Logger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.log`);
  return (message: string) => {
    const line = `${now().toISOString()} [${name}] ${message}`;
    console.log(line);
    try {
      appendFileSync(file, line + '\n');
    } catch {
      // A full or read-only disk must not crash the shell; stdout still has the line.
    }
  };
}
