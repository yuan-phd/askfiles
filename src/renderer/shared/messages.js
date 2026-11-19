// Messages about what AskFiles reads and follows, in English or Chinese by the system language
// (owner decision 2026-11-16): Chinese when the language is Chinese, English otherwise. The rest
// of the window has no other locale yet.

/** True when the system language is Chinese (zh, zh-CN, zh-Hans-CN, zh-TW). */
export function isChinese(lang = globalThis.navigator?.language || '') {
  return /^zh\b/i.test(lang);
}

/**
 * The file types AskFiles reads, as the user knows them. Must list what src/main/sections
 * SUPPORTED_EXTENSIONS lists (messages.test.js checks the two agree).
 */
export const SUPPORTED_TYPES = [
  { name: 'PDF', extensions: ['.pdf'] },
  { name: 'Word', extensions: ['.docx'] },
  { name: 'Excel', extensions: ['.xlsx', '.xlsm', '.xls'] },
  { name: 'PowerPoint', extensions: ['.pptx'] },
  { name: 'Markdown', extensions: ['.md', '.markdown'] },
  { name: 'Text', extensions: ['.txt'] },
];

function typesList(zh) {
  if (zh) {
    const parts = SUPPORTED_TYPES.map((t) =>
      t.name === 'Text' ? `文本（${t.extensions.join('、')}）` : `${t.name}（${t.extensions.join('、')}）`,
    );
    return `${parts.slice(0, -1).join('、')}和${parts[parts.length - 1]}`;
  }
  const parts = SUPPORTED_TYPES.map((t) => `${t.name === 'Text' ? 'text' : t.name} (${t.extensions.join(', ')})`);
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function names(items, zh) {
  const first = items[0].name;
  if (items.length === 1) return first;
  return zh ? `${first} 等 ${items.length} 个文件` : `${first} and ${items.length - 1} more`;
}

/** A file or files of a type AskFiles does not read were dropped or chosen. */
export function unsupportedText(items, lang) {
  const zh = isChinese(lang);
  return zh
    ? `未添加：${names(items, zh)}。AskFiles 无法读取这种类型的文件。可以读取的类型：${typesList(zh)}。`
    : `Not added: ${names(items, zh)}. AskFiles cannot read this type of file. It reads ${typesList(zh)} files.`;
}

/** A folder that would take the library past the folder limit (src/main/watcher/folder-limit.ts). */
export function tooLargeText(item, lang) {
  const zh = isChinese(lang);
  const limit = Number(item.limit) || 1000;
  return zh
    ? `未添加：${item.name}。这个文件夹太大，其中的子文件夹超过 ${limit.toLocaleString('en-US')} 个，AskFiles 无法跟踪。请改为分别添加其中较小的子文件夹。`
    : `Not added: ${item.name}. This folder is too large: it holds more than ${limit.toLocaleString('en-US')} subfolders, more than AskFiles can follow. Add smaller folders inside it instead, one at a time.`;
}

/** The notice for a library with folders left unwatched by the folder limit (WatcherStatus.notWatched). */
export function notWatchedText(lang) {
  return isChinese(lang)
    ? '部分文件夹中的更改不会被自动跟踪。点击 ↻ 检查更新即可找到这些更改。'
    : 'Changes in some folders are not followed. Click ↻ Check for updates to find them.';
}

/** The tooltip of that notice: why. */
export function notWatchedTip(lang) {
  return isChinese(lang)
    ? '这个资料库的文件夹太多，AskFiles 只跟踪其中一部分。所有文件仍可搜索；其余文件夹中的新文件和更改，在检查更新或下次启动时读取。'
    : 'This library has more folders than AskFiles can follow. All its files can still be searched; new and changed files in the other folders are read when you check for updates and at the next start.';
}

/**
 * The question after a start that did not finish (docs/tickets/startup-index-now-or-later.md):
 * the line and its two buttons in the top bar. Until the user answers, the library is open as
 * with Later.
 */
export function startChoiceText(lang) {
  return isChinese(lang)
    ? '上次 AskFiles 没有完成启动。现在检查这个资料库的文件夹有没有更改吗？在此之前，仍可以搜索已读取的文件。'
    : "AskFiles did not finish starting last time. Check this library's folders for changes now? Until then, you can still search the files already read.";
}

export function startNowLabel(lang) {
  return isChinese(lang) ? '现在开始读取' : 'Start indexing now';
}

export function startLaterLabel(lang) {
  return isChinese(lang) ? '稍后' : 'Later';
}

/** The top bar status while the library is open without checking its folders. */
export function notCheckedText(lang) {
  return isChinese(lang) ? '未检查更改' : 'Not checked for changes';
}
