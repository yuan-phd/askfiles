import path from 'node:path';
import { SUPPORTED_EXTENSIONS as SPLITTER_EXTENSIONS } from '../sections/index.js';

/**
 * File types the section splitter parses (src/main/sections). The collector converts more
 * (pptx, odt, epub, images; docs/upstream-analysis.md Q14), but those have no section parser yet.
 * Audio and video stay out for good: the collector would download a Whisper model to transcribe
 * them, which breaks the promise that nothing leaves the machine.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = SPLITTER_EXTENSIONS;

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
