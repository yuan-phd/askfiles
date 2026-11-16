import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_EXTENSIONS as SPLITTER_EXTENSIONS } from '../sections/index.js';

/**
 * File types the library reads (src/main/sections SUPPORTED_EXTENSIONS, the owner's whitelist).
 * Audio and video stay out for good: the collector would download a Whisper model to transcribe
 * them, which breaks the promise that nothing leaves the machine.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = SPLITTER_EXTENSIONS;

/**
 * Folders that never hold the user's documents and are never entered, counted or watched (owner
 * decision 2026-11-16): tool folders of code repositories, and folders of system files. Matched
 * without regard to case. Ordinary names such as build or dist are not here: people keep
 * documents in folders called that.
 */
const SKIPPED_NAMES = new Set(['node_modules', '__pycache__', '$recycle.bin', 'system volume information']);

/**
 * macOS package folders: Finder shows each as one file. Applications and libraries hold thousands
 * of folders of program data; documents saved as packages (Pages, Numbers, Keynote, RTFD) are not
 * a type AskFiles reads, and a Pages package holds a preview PDF that would otherwise be indexed
 * as a document of its own.
 */
const PACKAGE_SUFFIXES = [
  '.app',
  '.bundle',
  '.framework',
  '.plugin',
  '.kext',
  '.photoslibrary',
  '.pages',
  '.numbers',
  '.key',
  '.rtfd',
];

/** True for a folder name that is skipped wherever it appears below a linked folder. */
export function isSkippedFolderName(name: string): boolean {
  if (name.startsWith('.')) return true;
  const lower = name.toLowerCase();
  return SKIPPED_NAMES.has(lower) || PACKAGE_SUFFIXES.some((s) => lower.endsWith(s));
}

/** The marker file of a Python virtual environment (python -m venv writes it at the top). */
export const VENV_MARKER = 'pyvenv.cfg';

/** True for a folder that is a Python virtual environment. One stat. */
export function isVenvFolder(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, VENV_MARKER), { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** The parts of p below root, or null when p is root itself or not below it. */
function partsBelow(p: string, root: string): string[] | null {
  const rel = path.relative(root, p);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

/**
 * True when p lies in a skipped folder below root, by name only (no disk access): a hidden or
 * skipped folder anywhere between root and p, or p itself when it is such a folder. The root
 * itself is never skipped: a folder the user linked on purpose is read even if its name is one of
 * these.
 */
export function inSkippedFolder(p: string, root: string, pIsFolder = false): boolean {
  const parts = partsBelow(p, root);
  if (!parts) return false;
  const folders = pIsFolder ? parts : parts.slice(0, -1);
  return folders.some(isSkippedFolderName);
}

/**
 * True for files the library should read: a supported type, below root, not in a skipped folder,
 * not hidden (.DS_Store) and not an Office lock file (~$report.docx). By name only; a virtual
 * environment is found by the walk and the watch, which look at the folder (isVenvFolder).
 */
export function isIndexable(
  absPath: string,
  root: string,
  extensions: readonly string[] = SUPPORTED_EXTENSIONS,
): boolean {
  if (!extensions.includes(path.extname(absPath).toLowerCase())) return false;
  const parts = partsBelow(absPath, root);
  if (!parts) return false;
  const name = parts[parts.length - 1]!;
  if (name.startsWith('.') || name.startsWith('~$')) return false;
  return !inSkippedFolder(absPath, root);
}

/**
 * True for an indexed file the current rules would not read: its type left the list, or it lies
 * in a skipped folder (by name, or in a virtual environment between root and the file). Such
 * files stay in the index as they are (owner decision 2026-11-16): removing them would queue
 * hours of slow removals (docs/tickets/slow-section-removal.md). Reindex or deleting the library
 * takes them out. venvCache keeps one stat per folder across the files of one reconcile.
 */
export function isOutsideRules(
  absPath: string,
  root: string,
  extensions: readonly string[] = SUPPORTED_EXTENSIONS,
  venvCache: Map<string, boolean> = new Map(),
): boolean {
  if (!extensions.includes(path.extname(absPath).toLowerCase())) return true;
  const parts = partsBelow(absPath, root);
  if (!parts) return false;
  if (inSkippedFolder(absPath, root)) return true;
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    let venv = venvCache.get(dir);
    if (venv === undefined) venvCache.set(dir, (venv = isVenvFolder(dir)));
    if (venv) return true;
  }
  return false;
}
