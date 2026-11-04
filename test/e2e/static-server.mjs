// Serves src/renderer over HTTP for the tests; Chromium refuses ES modules from file:// URLs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../src/renderer');
// As the app serves it (src/main/app-protocol.ts VENDOR_FILES): d3 from the shell's node_modules.
const VENDOR = { '/vendor/d3.min.js': resolve(import.meta.dirname, '../../node_modules/d3/dist/d3.min.js') };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf' };

export function startStaticServer() {
  const server = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = VENDOR[path.replace(/\\/g, '/')] ?? join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(ROOT) && !Object.values(VENDOR).includes(file)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      res({ url: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((r) => server.close(r)) });
    });
  });
}
