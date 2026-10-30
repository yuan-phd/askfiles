/**
 * Streaming chat call to the bundled Ollama (POST /api/chat), with thinking off. Ollama answers
 * with one JSON object per line: { message: { content, thinking? }, done, ...counts }.
 */
import type { ChatMessage } from './prompt.js';

export type FetchLike = typeof globalThis.fetch;

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  /** num_ctx; the context length the preset sets for the chat model. */
  contextLength: number;
  signal?: AbortSignal;
}

export interface ChatStats {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** The part of a chat call the pipeline uses, so tests and the eval can pass a fake. */
export type ChatFn = (o: ChatOptions, onText: (text: string) => void) => Promise<ChatStats>;

/**
 * Removes <think>...</think> blocks from streamed text, holding back a tag cut between chunks. A
 * model that ignores think false still shows no reasoning.
 */
export class ThinkFilter {
  private buf = '';
  private inside = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.inside) {
        const close = this.buf.indexOf('</think>');
        if (close < 0) {
          // Keep only what could be the start of the closing tag.
          this.buf = this.buf.slice(Math.max(0, this.buf.length - 7));
          return out;
        }
        this.buf = this.buf.slice(close + 8);
        this.inside = false;
        continue;
      }
      const open = this.buf.indexOf('<think>');
      if (open >= 0) {
        out += this.buf.slice(0, open);
        this.buf = this.buf.slice(open + 7);
        this.inside = true;
        continue;
      }
      // Hold a trailing partial <think so it is not shown.
      const lt = this.buf.lastIndexOf('<');
      const hold = lt >= 0 && '<think>'.startsWith(this.buf.slice(lt)) ? lt : this.buf.length;
      out += this.buf.slice(0, hold);
      this.buf = this.buf.slice(hold);
      return out;
    }
  }

  end(): string {
    const rest = this.inside ? '' : this.buf;
    this.buf = '';
    this.inside = false;
    return rest;
  }
}

export function ollamaChat(baseUrl: () => string, fetchImpl: FetchLike = globalThis.fetch): ChatFn {
  return async (o, onText) => {
    const body = (think: boolean) =>
      JSON.stringify({
        model: o.model,
        messages: o.messages,
        stream: true,
        ...(think ? { think: false } : {}),
        options: { temperature: o.temperature, num_ctx: o.contextLength },
      });
    const url = `${baseUrl().replace(/\/+$/, '')}/api/chat`;
    const post = (think: boolean) =>
      fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body(think),
        signal: o.signal,
      });
    let res = await post(true);
    if (res.status === 400) {
      const text = await res.text();
      // A model without thinking support may refuse the think option; it cannot think anyway.
      if (!/think/i.test(text)) throw new Error(`Ollama /api/chat returned 400: ${text.slice(0, 300)}`);
      res = await post(false);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama /api/chat returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const filter = new ThinkFilter();
    const stats: ChatStats = { promptTokens: null, completionTokens: null };
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (line: string) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as {
        message?: { content?: string };
        error?: string;
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      if (msg.error) throw new Error(`Ollama: ${msg.error}`);
      const piece = filter.push(msg.message?.content ?? '');
      if (piece) onText(piece);
      if (msg.done) {
        stats.promptTokens = msg.prompt_eval_count ?? null;
        stats.completionTokens = msg.eval_count ?? null;
      }
    };
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: !done });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (done) break;
    }
    handle(buf);
    const rest = filter.end();
    if (rest) onText(rest);
    return stats;
  };
}
