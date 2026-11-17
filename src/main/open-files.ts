import { execFileSync } from 'node:child_process';

/**
 * The open-file limit of this process, as a child shell inherits it (Node has no getrlimit). Every
 * watched file holds an open file on macOS, and an app started from Finder may get a lower limit
 * than one started from a terminal, so the packaged app writes it to main.log at start. Null on
 * Windows, which has no such limit, and when the shell cannot run.
 */
export function openFileLimit(
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 }),
  platform: NodeJS.Platform = process.platform,
): { soft: string; hard: string } | null {
  if (platform === 'win32') return null;
  try {
    const [soft, hard] = run('/bin/sh', ['-c', 'ulimit -Sn; ulimit -Hn']).trim().split(/\s+/);
    return soft && hard ? { soft, hard } : null;
  } catch {
    return null;
  }
}
