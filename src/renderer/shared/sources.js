// The sources of a library as the pages list them (src/main/libraries.ts SourceView): the rows
// of the library menu in the top bar, and the Sources section of the Library page in Browse.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Rows of sources the library menu lists before the rest goes into one row. */
export const MENU_SOURCE_ROWS = 5;

/**
 * The library menu's sources: every linked folder, then added files until the list holds five
 * rows; what is not listed is counted for the "N more files · Manage" row (more is null when
 * everything is listed). Five or more folders: all folders, no added files.
 */
export function menuSources(sources) {
  const folders = sources.filter((s) => s.kind === 'folder');
  const files = sources.filter((s) => s.kind !== 'folder');
  const room = Math.max(0, MENU_SOURCE_ROWS - folders.length);
  const listed = files.length <= room ? files : files.slice(0, room);
  const rest = files.length - listed.length;
  return { rows: [...folders, ...listed], more: rest ? { folders: 0, files: rest } : null };
}

/** "898 more files", "1 more file", or "N more folders and files" when both are left out. */
export function moreText(more) {
  if (!more) return '';
  const n = more.folders + more.files;
  if (more.folders && more.files) return `${n} more folders and files`;
  if (more.folders) return plural(n, 'more folder', 'more folders');
  return plural(n, 'more file', 'more files');
}

/** ok, missing or unavailable (src/main/libraries.ts SourceView.status); older views only had available. */
export function sourceStatus(s) {
  if (s.status) return s.status;
  if (s.available !== false) return 'ok';
  return s.kind === 'folder' ? 'unavailable' : 'missing';
}

/** What a source is: Folder, File or Copy. */
export function sourceKindText(s) {
  if (s.kind === 'folder') return 'Folder';
  if (s.kind === 'copy') return 'Copy';
  return 'File';
}

/** The mark of a source that is not ok: Not available (kept, answerable) or Original missing (leaving). */
export function sourceStatusText(s) {
  return { unavailable: 'Not available', missing: 'Original missing' }[sourceStatus(s)] || '';
}

/** The menu's one label: the type, and its mark after a comma. */
export function sourceMenuText(s) {
  const mark = sourceStatusText(s);
  return mark ? `${sourceKindText(s)}, ${mark.toLowerCase()}` : sourceKindText(s);
}

/** Sources whose name or path holds the query, ignoring case; all of them for an empty query. */
export function filterSources(sources, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return sources;
  return sources.filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q));
}

/** "3 folders, 900 files, 1 copy": what the Sources section holds. */
export function sourcesCountText(sources) {
  const n = (kind) => sources.filter((s) => s.kind === kind).length;
  const parts = [];
  if (n('folder')) parts.push(plural(n('folder'), 'folder', 'folders'));
  if (n('file')) parts.push(plural(n('file'), 'file', 'files'));
  if (n('copy')) parts.push(plural(n('copy'), 'copy', 'copies'));
  return parts.join(', ') || 'No sources';
}

/** The note over the Sources list when added files lost their originals and are about to leave. */
export function missingText(sources) {
  const n = sources.filter((s) => s.kind === 'file' && sourceStatus(s) === 'missing').length;
  if (!n) return '';
  return n === 1
    ? '1 original is missing. It leaves the library once AskFiles has checked it.'
    : `${n} originals are missing. They leave the library once AskFiles has checked them.`;
}
