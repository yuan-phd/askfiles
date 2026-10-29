// Thin client for the Ollama HTTP API (github.com/ollama/ollama docs/api.md). The shell uses HTTP
// rather than the ollama CLI so pulls can report progress and nothing depends on a PATH.

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

export interface InstalledModel {
  /** Full tag as Ollama lists it, for example qwen3:8b or all-minilm:latest. */
  name: string;
  sizeBytes: number;
  digest: string;
  modifiedAt: string;
}

export interface PullProgress {
  model: string;
  /** Last status line from Ollama, for example pulling manifest, verifying sha256 digest, success. */
  status: string;
  completedBytes: number;
  totalBytes: number;
  /** 0 to 100, never decreasing during one pull; 100 only once Ollama reports success. */
  percent: number;
}

export type FetchLike = typeof globalThis.fetch;

/** Ollama treats a name without a tag as name:latest; compare tags in that form. */
export function normalizeTag(tag: string): string {
  const name = tag.slice(tag.lastIndexOf('/') + 1);
  return name.includes(':') ? tag : `${tag}:latest`;
}

export class OllamaClient {
  readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(o: { baseUrl: string; fetch?: FetchLike }) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.fetch = o.fetch ?? globalThis.fetch;
  }

  private async call(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetch(this.baseUrl + route, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new OllamaError(`${method} ${route} failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Not JSON; keep the raw text.
      }
      throw new OllamaError(`${method} ${route} returned ${res.status}: ${message}`.trim(), res.status);
    }
    return res;
  }

  /** GET /api/tags */
  async list(): Promise<InstalledModel[]> {
    const data = (await (await this.call('GET', '/api/tags')).json()) as {
      models?: { name: string; size: number; digest: string; modified_at: string }[];
    };
    return (data.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      digest: m.digest,
      modifiedAt: m.modified_at,
    }));
  }

  async has(tag: string): Promise<boolean> {
    const want = normalizeTag(tag);
    return (await this.list()).some((m) => normalizeTag(m.name) === want);
  }

  /** POST /api/show; returns capabilities such as completion, thinking, embedding, or [] if not reported. */
  async capabilities(tag: string): Promise<string[]> {
    const data = (await (await this.call('POST', '/api/show', { model: tag })).json()) as { capabilities?: string[] };
    return data.capabilities ?? [];
  }

  /** DELETE /api/delete */
  async remove(tag: string): Promise<void> {
    await this.call('DELETE', '/api/delete', { model: tag });
  }

  /**
   * POST /api/pull with stream true. Ollama answers with one JSON object per line: status lines, and
   * per layer { digest, total, completed }. Bytes are summed over the layers seen so far; a layer
   * not announced yet is not in the total, so percent is held from going backwards. Resolves after
   * the success line; rejects on an error line or a stream that ends without success.
   */
  async pull(tag: string, onProgress: (p: PullProgress) => void = () => {}, signal?: AbortSignal): Promise<void> {
    const res = await this.call('POST', '/api/pull', { model: tag, stream: true }, signal);
    if (!res.body) throw new OllamaError(`POST /api/pull returned no body for ${tag}`);
    const layers = new Map<string, { total: number; completed: number }>();
    let percent = 0;
    let succeeded = false;

    const handle = (line: string): void => {
      if (line.trim() === '') return;
      let msg: { status?: string; error?: string; digest?: string; total?: number; completed?: number };
      try {
        msg = JSON.parse(line);
      } catch {
        throw new OllamaError(`unreadable pull progress line for ${tag}: ${line.slice(0, 200)}`);
      }
      if (msg.error) throw new OllamaError(`pull ${tag} failed: ${msg.error}`);
      if (msg.digest && typeof msg.total === 'number') {
        layers.set(msg.digest, { total: msg.total, completed: msg.completed ?? 0 });
      }
      let total = 0;
      let completed = 0;
      for (const l of layers.values()) {
        total += l.total;
        completed += Math.min(l.completed, l.total);
      }
      const status = msg.status ?? '';
      if (status === 'success') {
        succeeded = true;
        percent = 100;
        completed = total;
      } else if (total > 0) {
        percent = Math.max(percent, Math.min(99, Math.floor((completed * 100) / total)));
      }
      onProgress({ model: tag, status, completedBytes: completed, totalBytes: total, percent });
    };

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    handle(buffer + decoder.decode());
    if (!succeeded) throw new OllamaError(`pull ${tag} ended before Ollama reported success`);
  }
}
