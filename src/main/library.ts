/**
 * Library setup calls of the first run, ported from src/renderer/api/client.js (generateApiKey,
 * checkAuth, ensureLibrary) because the main process build only compiles src/main. The constants
 * must equal the page's; src/main/bridge/bridge.test.ts compares them.
 */

/** Name of the one hidden workspace that holds the library (client.js LIBRARY_NAME). */
export const LIBRARY_NAME = 'askfiles-library';

/** Workspace refusal text the search page detects (client.js REFUSAL_TEXT). */
export const REFUSAL_TEXT = 'Nothing in your documents answers this question.';

type Fetch = typeof fetch;

async function call(
  fetchImpl: Fetch,
  baseUrl: string,
  method: string,
  route: string,
  o: { apiKey?: string; json?: unknown } = {},
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const headers: Record<string, string> = {};
  if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;
  if (o.json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api${route}`, {
    method,
    headers,
    body: o.json === undefined ? undefined : JSON.stringify(o.json),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep the text
  }
  return { status: res.status, ok: res.ok, body };
}

function failure(method: string, route: string, r: { status: number; body: unknown }): Error {
  const b = r.body as { error?: string; message?: string } | null;
  return new Error(
    `${method} ${route} failed (${r.status}): ${b?.error ?? b?.message ?? String(r.body).slice(0, 200)}`,
  );
}

/**
 * Returns the stored key when the server still accepts it, else creates one with
 * POST /api/system/generate-api-key, which needs no token while the server runs without
 * AUTH_TOKEN, as the shell runs it.
 */
export async function ensureApiKey(
  baseUrl: string,
  stored: string | null,
  fetchImpl: Fetch = fetch,
): Promise<{ apiKey: string; created: boolean }> {
  if (stored) {
    const r = await call(fetchImpl, baseUrl, 'GET', '/v1/auth', { apiKey: stored });
    if (r.ok && (r.body as { authenticated?: boolean } | null)?.authenticated === true) {
      return { apiKey: stored, created: false };
    }
    if (r.status !== 401 && r.status !== 403) throw failure('GET', '/v1/auth', r);
  }
  const r = await call(fetchImpl, baseUrl, 'POST', '/system/generate-api-key', { json: { name: 'askfiles' } });
  const secret = (r.body as { apiKey?: { secret?: string } } | null)?.apiKey?.secret;
  if (!r.ok || !secret) throw failure('POST', '/system/generate-api-key', r);
  return { apiKey: secret, created: true };
}

/**
 * Finds a workspace by name and writes the preset settings into it, or creates it with them.
 * Returns its slug. Writing the settings every time keeps an existing library in step with the
 * preset after an update.
 */
export async function ensureWorkspace(
  baseUrl: string,
  apiKey: string,
  name: string,
  settings: Record<string, string | number>,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const body = { chatMode: 'query', queryRefusalResponse: REFUSAL_TEXT, ...settings };
  const list = await call(fetchImpl, baseUrl, 'GET', '/v1/workspaces', { apiKey });
  if (!list.ok) throw failure('GET', '/v1/workspaces', list);
  const existing = ((list.body as { workspaces?: { name?: string; slug?: string }[] } | null)?.workspaces ?? []).find(
    (w) => w.name === name,
  );
  if (existing?.slug) {
    const route = `/v1/workspace/${encodeURIComponent(existing.slug)}/update`;
    const r = await call(fetchImpl, baseUrl, 'POST', route, { apiKey, json: body });
    if (!r.ok) throw failure('POST', route, r);
    return existing.slug;
  }
  const r = await call(fetchImpl, baseUrl, 'POST', '/v1/workspace/new', {
    apiKey,
    json: { name, ...body },
  });
  const slug = (r.body as { workspace?: { slug?: string } } | null)?.workspace?.slug;
  if (!r.ok || !slug) throw failure('POST', '/v1/workspace/new', r);
  return slug;
}

/** The default library's workspace (named LIBRARY_NAME, the name Sessions H to J used). */
export function ensureLibrary(
  baseUrl: string,
  apiKey: string,
  settings: Record<string, string | number>,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  return ensureWorkspace(baseUrl, apiKey, LIBRARY_NAME, settings, fetchImpl);
}

/** Workspace name of a library other than the default one. */
export function workspaceNameOf(libraryId: string): string {
  return `askfiles-${libraryId}`;
}

/**
 * DELETE /v1/workspace/{slug}: upstream drops the workspace, its document links and its vectors.
 * A workspace that is already gone counts as deleted.
 */
export async function deleteWorkspace(baseUrl: string, apiKey: string, slug: string, fetchImpl: Fetch = fetch) {
  const route = `/v1/workspace/${encodeURIComponent(slug)}`;
  const r = await call(fetchImpl, baseUrl, 'DELETE', route, { apiKey });
  if (!r.ok && r.status !== 404 && r.status !== 400) throw failure('DELETE', route, r);
}
