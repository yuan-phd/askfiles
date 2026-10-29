import net from 'node:net';

/**
 * Asks the OS for `count` free ports on `host`. All sockets stay open until every port is
 * known, so the ports are distinct. Another process can still take a port between this call
 * and the child binding it; the child then fails its health check and start() reports it.
 */
export async function allocatePorts(count: number, host: string): Promise<number[]> {
  const servers: net.Server[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const s = net.createServer();
      servers.push(s);
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(0, host, () => resolve());
      });
    }
    return servers.map((s) => (s.address() as net.AddressInfo).port);
  } finally {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}
