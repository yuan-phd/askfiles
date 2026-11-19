import { describe, expect, it } from 'vitest';
import { SUPPORTED_EXTENSIONS } from '../../main/sections/index.js';
import {
  isChinese,
  notCheckedText,
  notWatchedText,
  notWatchedTip,
  startChoiceText,
  startLaterLabel,
  startNowLabel,
  SUPPORTED_TYPES,
  tooLargeText,
  unsupportedText,
} from './messages.js';
import { addResultIsLong, addResultText, lockLine, statusOf } from './topbar.js';

describe('messages about file types and the folder limit', () => {
  it('lists exactly the types the main process reads', () => {
    expect(SUPPORTED_TYPES.flatMap((t) => t.extensions).sort()).toEqual([...SUPPORTED_EXTENSIONS].sort());
  });

  it('is Chinese for any Chinese system language, English otherwise', () => {
    for (const l of ['zh', 'zh-CN', 'zh-Hans-CN', 'zh-TW', 'ZH-cn']) expect(isChinese(l), l).toBe(true);
    for (const l of ['en-US', 'de', 'ja-JP', '', 'zhx']) expect(isChinese(l), l).toBe(false);
  });

  it('words a file that cannot be read, with the types that can', () => {
    expect(unsupportedText([{ name: 'photo.heic' }], 'en-GB')).toBe(
      'Not added: photo.heic. AskFiles cannot read this type of file. It reads PDF (.pdf), Word (.docx), Excel (.xlsx, .xlsm, .xls), PowerPoint (.pptx), Markdown (.md, .markdown) and text (.txt) files.',
    );
    expect(unsupportedText([{ name: 'a.zip' }, { name: 'b.csv' }], 'en')).toMatch(/^Not added: a\.zip and 1 more\. /);
    expect(unsupportedText([{ name: 'photo.heic' }], 'zh-CN')).toBe(
      '未添加：photo.heic。AskFiles 无法读取这种类型的文件。可以读取的类型：PDF（.pdf）、Word（.docx）、Excel（.xlsx、.xlsm、.xls）、PowerPoint（.pptx）、Markdown（.md、.markdown）和文本（.txt）。',
    );
    expect(unsupportedText([{ name: 'a.zip' }, { name: 'b.csv' }], 'zh')).toMatch(/^未添加：a\.zip 等 2 个文件。/);
  });

  it('words a folder too large and the notice for folders not followed', () => {
    expect(tooLargeText({ name: 'Projects', limit: 1000 }, 'en-US')).toBe(
      'Not added: Projects. This folder is too large: it holds more than 1,000 subfolders, more than AskFiles can follow. Add smaller folders inside it instead, one at a time.',
    );
    expect(tooLargeText({ name: 'Projects', limit: 1000 }, 'zh-CN')).toBe(
      '未添加：Projects。这个文件夹太大，其中的子文件夹超过 1,000 个，AskFiles 无法跟踪。请改为分别添加其中较小的子文件夹。',
    );
    // Without a limit in the result (an older main process), the default limit.
    expect(tooLargeText({ name: 'Projects' }, 'en')).toMatch(/more than 1,000 subfolders/);
    expect(notWatchedText('en')).toBe(
      'Changes in some folders are not followed. Click ↻ Check for updates to find them.',
    );
    expect(notWatchedText('zh-CN')).toBe('部分文件夹中的更改不会被自动跟踪。点击 ↻ 检查更新即可找到这些更改。');
    expect(notWatchedTip('en')).toMatch(/^This library has more folders than AskFiles can follow\./);
    expect(notWatchedTip('zh-TW')).toMatch(/^这个资料库的文件夹太多/);
  });

  it('puts them in the add result, which then wraps and stays longer', () => {
    const r = {
      added: 1,
      skipped: [
        { name: 'Projects', reason: 'the folder holds more than 1000 subfolders', code: 'too-large', limit: 1000 },
        { name: 'x.zip', reason: 'not a type AskFiles can read', code: 'unsupported' },
        { name: 'y.pdf', reason: 'not found' },
      ],
    };
    expect(addResultText(r, 'en')).toBe(
      'Added 1 item. ' +
        tooLargeText(r.skipped[0], 'en') +
        ' ' +
        unsupportedText([r.skipped[1]], 'en') +
        ' Not added: y.pdf (not found).',
    );
    expect(addResultIsLong(r)).toBe(true);
    expect(addResultIsLong({ added: 0, skipped: [{ name: 'y.pdf', reason: 'not found' }] })).toBe(false);
  });
});

describe('the question after a start that did not finish', () => {
  it('words the question, its buttons and the status in English and Chinese', () => {
    expect(startChoiceText('en-US')).toBe(
      "AskFiles did not finish starting last time. Check this library's folders for changes now? Until then, you can still search the files already read.",
    );
    expect(startNowLabel('en')).toBe('Check now');
    expect(startLaterLabel('en')).toBe('Later');
    expect(notCheckedText('en')).toBe('Not checked for changes');
    expect(startChoiceText('zh-CN')).toBe(
      '上次 AskFiles 没有完成启动。现在检查这个资料库的文件夹有没有更改吗？在此之前，仍可以搜索已读取的文件。',
    );
    expect(startNowLabel('zh-TW')).toBe('现在开始读取');
    expect(startLaterLabel('zh')).toBe('稍后');
    expect(notCheckedText('zh-Hans-CN')).toBe('未检查更改');
  });

  it('shows Not checked for changes while a choice is in force, and never locks the question box', () => {
    const base = { state: 'stopped', pending: 0, indexed: 3, deadLetters: [], unavailable: [], notWatched: 0 };
    for (const startChoice of ['ask', 'later']) {
      const s = { ...base, startChoice };
      expect(statusOf(s).kind).toBe('not-checked');
      expect(lockLine(s)).toBeNull();
    }
    expect(statusOf(base)).toEqual({ kind: 'ready', text: 'Up to date' });
  });
});
