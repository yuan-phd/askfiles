import { afterEach, describe, expect, it } from 'vitest';
import { OllamaClient, OllamaError, normalizeTag, type PullProgress } from './client.js';
import { startFakeOllama, type FakeOllama } from './__fixtures__/fake-ollama.js';

let fake: FakeOllama | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe('normalizeTag', () => {
  it('adds latest only when the name has no tag', () => {
    expect(normalizeTag('bge-m3')).toBe('bge-m3:latest');
    expect(normalizeTag('qwen3:8b')).toBe('qwen3:8b');
    expect(normalizeTag('library/bge-m3')).toBe('library/bge-m3:latest');
  });
});

describe('OllamaClient.pull', () => {
  it('streams bytes and percent, never going back, and reaches 100 only on success', async () => {
    fake = await startFakeOllama({ layers: [1000, 10] });
    const events: PullProgress[] = [];
    await new OllamaClient({ baseUrl: fake.url + '/' }).pull('bge-m3:567m', (p) => events.push(p));

    expect(events[0]).toMatchObject({ status: 'pulling manifest', percent: 0, totalBytes: 0 });
    // First layer half done: 500 of 1000; the second layer is not announced yet.
    expect(events[1]).toMatchObject({ completedBytes: 500, totalBytes: 1000, percent: 50 });
    // Second layer appears: 1005 of 1010 is 99 percent, capped at 99 before success.
    expect(events.find((e) => e.totalBytes === 1010 && e.completedBytes === 1005)?.percent).toBe(99);
    const percents = events.map((e) => e.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.filter((p) => p === 100)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ status: 'success', percent: 100, completedBytes: 1010, totalBytes: 1010 });
    expect(fake.pulls).toEqual(['bge-m3:567m']);
  });

  it('rejects on an error line', async () => {
    fake = await startFakeOllama({ failPull: new Set(['qwen3:8b']) });
    await expect(new OllamaClient({ baseUrl: fake.url }).pull('qwen3:8b')).rejects.toThrow(
      /pull qwen3:8b failed: connection reset by peer/,
    );
  });

  it('rejects when the stream ends without success', async () => {
    const body = new Response('{"status":"pulling manifest"}\n').body;
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: async () => new Response(body) });
    await expect(client.pull('a:b')).rejects.toThrow(/ended before Ollama reported success/);
  });

  it('reports the HTTP status and Ollama error text', async () => {
    const client = new OllamaClient({
      baseUrl: 'http://x',
      fetch: async () => new Response('{"error":"pull model manifest: file does not exist"}', { status: 500 }),
    });
    const err = await client.pull('nope:1b').catch((e) => e);
    expect(err).toBeInstanceOf(OllamaError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('POST /api/pull returned 500: pull model manifest: file does not exist');
  });

  it('wraps a refused connection', async () => {
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(client.list()).rejects.toThrow(/GET \/api\/tags failed/);
  });
});

describe('OllamaClient list, has, capabilities, remove', () => {
  it('maps /api/tags and matches untagged names as latest', async () => {
    fake = await startFakeOllama({ installed: [{ name: 'all-minilm:latest', size: 45 }] });
    const c = new OllamaClient({ baseUrl: fake.url });
    expect(await c.list()).toEqual([
      { name: 'all-minilm:latest', sizeBytes: 45, digest: 'd-all-minilm:latest', modifiedAt: 'x' },
    ]);
    expect(await c.has('all-minilm')).toBe(true);
    expect(await c.has('qwen3:8b')).toBe(false);
    expect(await c.capabilities('all-minilm:latest')).toEqual(['completion']);
    await c.remove('all-minilm:latest');
    expect(await c.list()).toEqual([]);
    await expect(c.remove('all-minilm:latest')).rejects.toThrow(/404: model 'all-minilm:latest' not found/);
  });
});
