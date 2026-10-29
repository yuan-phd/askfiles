// Serves src/renderer over HTTP for the tests; Chromium refuses ES modules from file:// URLs.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../src/renderer");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };

export function startStaticServer() {
  const server = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      res({ url: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((r) => server.close(r)) });
    });
  });
}
