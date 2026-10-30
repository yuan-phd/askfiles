import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The pages load from askfiles://app/<page>/index.html, served from src/renderer inside the app
 * bundle, not from the server. A custom scheme rather than file://: Chromium refuses ES modules
 * from file:// URLs, and a standard secure scheme gives the pages one stable origin
 * (askfiles://app) for localStorage and for the server's allowed-origins list (patch 005).
 */
export const APP_SCHEME = 'askfiles';
export const APP_ORIGIN = `${APP_SCHEME}://app`;

export type PageName = 'onboarding' | 'ask' | 'models' | 'about' | 'settings' | 'developer';

export function pageUrl(page: PageName): string {
  return `${APP_ORIGIN}/${page}/index.html`;
}

/** Path served for the third-party notices file, which lives at the app root, not in src/renderer. */
export const NOTICES_PATH = '/THIRD-PARTY-NOTICES';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'text/plain; charset=utf-8';
}

/**
 * Maps a request URL to a file under rendererDir, or to the notices file. Anything else, another
 * host, or a path that leaves rendererDir after decoding, is null.
 */
export function resolveAppFile(url: string, o: { rendererDir: string; noticesFile: string }): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== 'app') return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel === NOTICES_PATH) return o.noticesFile;
  if (rel.includes('\0')) return null;
  const root = path.resolve(o.rendererDir);
  const file = path.resolve(root, '.' + (rel.endsWith('/') ? `${rel}index.html` : rel));
  return file.startsWith(root + path.sep) ? file : null;
}

/** The protocol.handle callback: 404 for anything resolveAppFile refuses or cannot read. */
export function appProtocolHandler(o: {
  rendererDir: string;
  noticesFile: string;
}): (request: { url: string }) => Promise<Response> {
  return async (request) => {
    const file = resolveAppFile(request.url, o);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      // fs reads inside app.asar in the packaged app; electron patches node:fs for that.
      const body = await fs.readFile(file);
      return new Response(new Uint8Array(body), { status: 200, headers: { 'Content-Type': contentType(file) } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}
