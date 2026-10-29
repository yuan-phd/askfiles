import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, parsePort, resolveLogDir, resolvePort } from './config.js';

function enoent(): never {
  const err = new Error('missing') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
}

describe('parsePort', () => {
  it('accepts numbers and digit strings', () => {
    expect(parsePort(3001, 'x')).toBe(3001);
    expect(parsePort(' 51342 ', 'x')).toBe(51342);
  });

  it.each(['', 'abc', '1e3', '-1', '3001.5', '0', '65536', null, {}])('rejects %j', (value) => {
    expect(() => parsePort(value, 'x')).toThrow();
  });
});

describe('resolvePort', () => {
  it('prefers the environment variable over the config file', () => {
    const readFile = vi.fn(() => '{"port": 4000}');
    const result = resolvePort({ env: { ASKFILES_PORT: '5000' }, defaultConfigPath: '/c.json', readFile });
    expect(result).toEqual({ port: 5000, source: 'ASKFILES_PORT' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads the default config file when the env variable is empty', () => {
    const readFile = vi.fn(() => '{"port": 4000}');
    const result = resolvePort({ env: { ASKFILES_PORT: '' }, defaultConfigPath: '/c.json', readFile });
    expect(result).toEqual({ port: 4000, source: '/c.json' });
    expect(readFile).toHaveBeenCalledWith('/c.json');
  });

  it('uses ASKFILES_CONFIG as the config path', () => {
    const readFile = vi.fn(() => '{"port": "4001"}');
    const result = resolvePort({ env: { ASKFILES_CONFIG: '/other.json' }, defaultConfigPath: '/c.json', readFile });
    expect(result).toEqual({ port: 4001, source: '/other.json' });
  });

  it('returns null when nothing is configured', () => {
    expect(resolvePort({ env: {}, defaultConfigPath: '/c.json', readFile: enoent })).toBeNull();
    expect(resolvePort({ env: {}, defaultConfigPath: '/c.json', readFile: () => '{}' })).toBeNull();
  });

  it('throws on invalid values instead of guessing', () => {
    expect(() => resolvePort({ env: { ASKFILES_PORT: 'abc' }, defaultConfigPath: '/c.json' })).toThrow(/ASKFILES_PORT/);
    expect(() => resolvePort({ env: {}, defaultConfigPath: '/c.json', readFile: () => 'not json' })).toThrow(
      /not valid JSON/,
    );
    expect(() => resolvePort({ env: {}, defaultConfigPath: '/c.json', readFile: () => '{"port": 70000}' })).toThrow();
  });

  it('rethrows read errors other than a missing file', () => {
    const readFile = () => {
      const err = new Error('denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    expect(() => resolvePort({ env: {}, defaultConfigPath: '/c.json', readFile })).toThrow('denied');
  });
});

describe('resolveLogDir', () => {
  it('uses ASKFILES_LOG_DIR when set', () => {
    expect(resolveLogDir({ ASKFILES_LOG_DIR: '/logs' }, '/default')).toBe('/logs');
    expect(resolveLogDir({ ASKFILES_LOG_DIR: '' }, '/default')).toBe('/default');
    expect(resolveLogDir({}, '/default')).toBe('/default');
  });
});

describe('createLogger', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates the directory and appends one prefixed line per event', () => {
    dir = mkdtempSync(join(tmpdir(), 'askfiles-log-'));
    const logDir = join(dir, 'nested', 'logs');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger(logDir, 'main', () => new Date('2026-10-29T00:00:00Z'));
    log('first');
    log('second');
    expect(readFileSync(join(logDir, 'main.log'), 'utf8')).toBe(
      '2026-10-29T00:00:00.000Z [main] first\n2026-10-29T00:00:00.000Z [main] second\n',
    );
  });
});
