/**
 * The pinned chat model of a tier (Preset.chatModelFile). Ollama pulls hf.co/<repository>:<quant>
 * from the repository's current revision and has no way to ask for an older one, so the pin is
 * checked after the pull: the weights Ollama installed must have the sha256 of the file measured
 * in phase 2. A repository that later replaces the file makes the check fail with a message, not
 * a silently different model.
 */
import type { ChatModelFile } from '../presets/schema.js';
import type { OllamaClient } from '../ollama/client.js';

export class PinnedModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinnedModelError';
  }
}

/** Throws PinnedModelError unless tag's weights are the pinned file. */
export async function verifyPinnedModel(
  ollama: Pick<OllamaClient, 'weightsDigest'>,
  tag: string,
  file: ChatModelFile,
  log?: (message: string) => void,
): Promise<void> {
  const digest = await ollama.weightsDigest(tag);
  if (digest === file.sha256) {
    log?.(`[models] ${tag} matches ${file.repository}@${file.revision.slice(0, 8)} ${file.file}`);
    return;
  }
  throw new PinnedModelError(
    `${tag} is not the tested model file: expected ${file.file} from ${file.repository} at revision ${file.revision} ` +
      `(sha256 ${file.sha256}), Ollama installed ${digest ? `sha256 ${digest}` : 'weights it did not report'}. ` +
      'The repository may have replaced the file; delete the model and update the preset after measuring the new one.',
  );
}
