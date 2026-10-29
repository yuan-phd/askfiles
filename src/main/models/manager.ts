import fs from 'node:fs';
import util from 'node:util';
import { normalizeTag, type OllamaClient, type PullProgress } from '../ollama/client.js';
import { writeServerEnv } from '../presets/index.js';

export interface ModelEntry {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  /** chat: OLLAMA_MODEL_PREF in the server .env; embedding: EMBEDDING_MODEL_PREF. */
  role: 'chat' | 'embedding' | null;
}

export interface ModelManagerDeps {
  ollama: OllamaClient;
  /** <dataDir>/server/.env */
  envFile: string;
  /** Restart the server so it reads the .env again; resolves once it is healthy. */
  restartServer(): Promise<unknown>;
  log?: (message: string) => void;
}

/**
 * Backs the model manager page: list, pull, delete and switch the chat model, all through the
 * Ollama HTTP API. The active models are whatever the server .env names, so the page and the
 * server never disagree about which model answers.
 */
export class ModelManager {
  constructor(private readonly d: ModelManagerDeps) {}

  private active(): { chat: string | null; embedding: string | null } {
    let env: Record<string, string> = {};
    try {
      env = util.parseEnv(fs.readFileSync(this.d.envFile, 'utf8')) as Record<string, string>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return { chat: env.OLLAMA_MODEL_PREF ?? null, embedding: env.EMBEDDING_MODEL_PREF ?? null };
  }

  async list(): Promise<ModelEntry[]> {
    const { chat, embedding } = this.active();
    const is = (name: string, tag: string | null) => tag !== null && normalizeTag(name) === normalizeTag(tag);
    return (await this.d.ollama.list()).map((m) => ({
      name: m.name,
      sizeBytes: m.sizeBytes,
      modifiedAt: m.modifiedAt,
      role: is(m.name, chat) ? 'chat' : is(m.name, embedding) ? 'embedding' : null,
    }));
  }

  pull(tag: string, onProgress?: (p: PullProgress) => void): Promise<void> {
    this.log(`pulling ${tag}`);
    return this.d.ollama.pull(tag, onProgress);
  }

  /** Refuses the active chat and embedding models: deleting either would break search or indexing. */
  async remove(tag: string): Promise<void> {
    const { chat, embedding } = this.active();
    for (const [role, active] of [
      ['chat', chat],
      ['embedding', embedding],
    ] as const) {
      if (active !== null && normalizeTag(active) === normalizeTag(tag)) {
        throw new Error(`${tag} is the active ${role} model; switch to another model before deleting it`);
      }
    }
    await this.d.ollama.remove(tag);
    this.log(`deleted ${tag}`);
  }

  /**
   * Sets OLLAMA_MODEL_PREF and restarts the server. The model must be installed and able to chat:
   * an embedding model reports only the embedding capability in /api/show.
   */
  async switchChatModel(tag: string): Promise<void> {
    if (!(await this.d.ollama.has(tag))) throw new Error(`${tag} is not installed; download it first`);
    const caps = await this.d.ollama.capabilities(tag);
    if (caps.length > 0 && !caps.includes('completion'))
      throw new Error(`${tag} cannot answer questions (${caps.join(', ')})`);
    writeServerEnv(this.d.envFile, [['OLLAMA_MODEL_PREF', tag]]);
    this.log(`chat model set to ${tag}, restarting server`);
    await this.d.restartServer();
  }

  private log(message: string): void {
    this.d.log?.(`[models] ${message}`);
  }
}
