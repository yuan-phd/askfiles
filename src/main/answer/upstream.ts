/** The upstream vector-search route, the only upstream call the pipeline makes. */
import type { FetchLike } from './ollama-chat.js';
import type { RawVectorHit } from './pipeline.js';

/**
 * POST /api/v1/workspace/:slug/vector-search with scoreThreshold 0, so the nearest chunks come
 * back whatever their score (upstream/server/endpoints/api/workspace/index.js).
 */
export function upstreamVectorSearch(o: {
  baseUrl: () => string | null;
  apiKey: string;
  slug: string;
  fetch?: FetchLike;
}): (question: string, topK: number, signal?: AbortSignal) => Promise<RawVectorHit[]> {
  const fetchImpl = o.fetch ?? globalThis.fetch;
  return async (question, topK, signal) => {
    const base = o.baseUrl();
    if (!base) throw new Error('the search engine is not running');
    const res = await fetchImpl(`${base}/api/v1/workspace/${encodeURIComponent(o.slug)}/vector-search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: question, topN: topK, scoreThreshold: 0 }),
      signal,
    });
    if (!res.ok) throw new Error(`vector search returned ${res.status}`);
    const data = (await res.json()) as { results?: RawVectorHit[] };
    return data.results ?? [];
  };
}
