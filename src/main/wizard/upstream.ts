import type { FetchLike } from '../ollama/client.js';

/**
 * Marks upstream onboarding complete and checks it took. The server already does this at boot when
 * LLM_PROVIDER or VECTOR_DB is set (docs/upstream-analysis.md Q5); the explicit call covers a server
 * that booted before the preset was written. POST /api/onboarding needs no token while AUTH_TOKEN
 * is unset, which is how the shell runs the server.
 */
export async function markUpstreamOnboarded(baseUrl: string, fetchImpl: FetchLike = globalThis.fetch): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '');
  const post = await fetchImpl(`${base}/api/onboarding`, { method: 'POST' });
  if (!post.ok) throw new Error(`POST /api/onboarding returned ${post.status}`);
  const get = await fetchImpl(`${base}/api/onboarding`);
  if (!get.ok) throw new Error(`GET /api/onboarding returned ${get.status}`);
  const body = (await get.json()) as { onboardingComplete?: boolean };
  if (body.onboardingComplete !== true) throw new Error('server still reports onboarding incomplete');
}
