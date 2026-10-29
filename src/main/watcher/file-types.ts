import path from 'node:path';

/**
 * Extensions the collector converts at the pinned tag (upstream/collector/utils/constants.js,
 * SUPPORTED_FILETYPE_CONVERTERS; docs/upstream-analysis.md Q14). Audio and video are left out:
 * the collector transcribes them with a Whisper model downloaded from Hugging Face on first use,
 * which would break the promise that nothing leaves the machine.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.txt',
  '.md',
  '.org',
  '.adoc',
  '.rst',
  '.csv',
  '.json',
  '.html',
  '.pdf',
  '.docx',
  '.pptx',
  '.odt',
  '.odp',
  '.xlsx',
  '.mbox',
  '.epub',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
];

/**
 * True for files the library should hold. Hidden files and folders (.DS_Store, .git) and Office
 * lock files (~$report.docx) are never documents.
 */
export function isIndexable(
  absPath: string,
  root: string,
  extensions: readonly string[] = SUPPORTED_EXTENSIONS,
): boolean {
  if (!extensions.includes(path.extname(absPath).toLowerCase())) return false;
  const rel = path.relative(root, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).some((part) => part.startsWith('.') || part.startsWith('~$'));
}

/** True for a path below root inside a hidden folder or itself hidden; never walked or watched. */
export function isHidden(absPath: string, root: string): boolean {
  const rel = path.relative(root, absPath);
  if (rel === '') return false;
  return rel.split(path.sep).some((part) => part.startsWith('.'));
}
