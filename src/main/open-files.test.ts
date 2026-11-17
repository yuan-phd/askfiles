import { describe, expect, it } from 'vitest';
import { openFileLimit } from './open-files.js';

describe('openFileLimit', () => {
  it('reads the soft and hard limit from a child shell', () => {
    const calls: string[][] = [];
    const r = openFileLimit((cmd, args) => {
      calls.push([cmd, ...args]);
      return '256\nunlimited\n';
    }, 'darwin');
    expect(r).toEqual({ soft: '256', hard: 'unlimited' });
    expect(calls).toEqual([['/bin/sh', '-c', 'ulimit -Sn; ulimit -Hn']]);
  });

  it('gives null on Windows and when the shell fails', () => {
    expect(openFileLimit(() => '1', 'win32')).toBeNull();
    expect(
      openFileLimit(() => {
        throw new Error('no shell');
      }, 'linux'),
    ).toBeNull();
  });

  it('reads this process for real on macOS and Linux', () => {
    if (process.platform === 'win32') return;
    expect(openFileLimit()).toMatchObject({ soft: expect.stringMatching(/^(\d+|unlimited)$/) });
  });
});
