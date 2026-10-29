import http from 'node:http';

// A private agent keeps health probes off any proxy configured for the global agent.
const agent = new http.Agent({ keepAlive: false });

/** Resolves with the HTTP status, or null when the request fails or times out. */
export function probe(url: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { agent, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

export type HealthResult = 'healthy' | 'timeout' | 'exited';

/**
 * Polls `url` until it answers 200, the deadline passes, or `exited` settles (the child died,
 * so waiting longer is pointless).
 */
export async function waitForHealthy(
  url: string,
  opts: { timeoutMs: number; intervalMs: number; exited?: Promise<unknown> },
): Promise<HealthResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let gone = false;
  opts.exited?.then(() => (gone = true));
  while (!gone) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    if ((await probe(url, Math.min(2000, remaining))) === 200) return 'healthy';
    if (gone) break;
    const wait = Math.min(opts.intervalMs, deadline - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return 'exited';
}
