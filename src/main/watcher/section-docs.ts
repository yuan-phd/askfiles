import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Folder under STORAGE_DIR/documents that holds every section document the shell writes. The
 * documents and their names come from src/main/sections (sectionDocuments), like the eval harness.
 */
export const DOCS_FOLDER = 'askfiles';

export async function hashFile(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export function documentsDir(storageDir: string): string {
  return path.join(storageDir, 'documents');
}

export function writeSectionDocument(storageDir: string, location: string, doc: object): void {
  const file = path.join(documentsDir(storageDir), location);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc));
}

/** A section document as written, or null when it is missing or unreadable. */
export function readSectionDocument(storageDir: string, location: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(documentsDir(storageDir), location), 'utf8')) as unknown;
    return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readSectionText(storageDir: string, location: string): string | null {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(documentsDir(storageDir), location), 'utf8')) as {
      pageContent?: unknown;
    };
    return typeof doc.pageContent === 'string' ? doc.pageContent : null;
  } catch {
    return null;
  }
}
