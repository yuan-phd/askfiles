import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isIndexable, isOutsideRules, isSkippedFolderName, isVenvFolder, SUPPORTED_EXTENSIONS } from './file-types.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-types-')));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const root = '/Users/someone/Documents';
const at = (...parts: string[]) => path.join(root, ...parts);

describe('file types', () => {
  it('reads exactly pdf, docx, xlsx, xlsm, xls, pptx, md, markdown and txt', () => {
    expect([...SUPPORTED_EXTENSIONS].sort()).toEqual(
      ['.docx', '.markdown', '.md', '.pdf', '.pptx', '.txt', '.xls', '.xlsm', '.xlsx'].sort(),
    );
  });

  it('matches each type without regard to case, and nothing else', () => {
    for (const name of [
      'a.pdf',
      'b.DOCX',
      'c.Xlsx',
      'd.xlsm',
      'e.XLS',
      'f.pptx',
      'g.PPTX',
      'h.md',
      'i.Markdown',
      'j.TXT',
    ])
      expect(isIndexable(at(name), root), name).toBe(true);
    for (const name of ['a.csv', 'b.doc', 'c.ppt', 'd.key', 'e.pages', 'f.zip', 'g.js', 'h.json', 'i.heic', 'j'])
      expect(isIndexable(at(name), root), name).toBe(false);
  });

  it('never reads hidden files, Office lock files, or the root itself', () => {
    expect(isIndexable(at('.notes.md'), root)).toBe(false);
    expect(isIndexable(at('~$report.docx'), root)).toBe(false);
    expect(isIndexable(root, root)).toBe(false);
    expect(isIndexable('/elsewhere/a.md', root)).toBe(false);
  });
});

describe('skipped folders', () => {
  it('skips dot folders, node_modules, __pycache__, Windows system folders and macOS packages, in any case', () => {
    for (const name of [
      '.git',
      '.venv',
      '.cache',
      'node_modules',
      'Node_Modules',
      '__pycache__',
      '$RECYCLE.BIN',
      'System Volume Information',
      'Calculator.app',
      'Helper.bundle',
      'Core.framework',
      'Audio.plugin',
      'Driver.kext',
      'Photos Library.photoslibrary',
      'Letter.pages',
      'Budget.numbers',
      'Talk.key',
      'Notes.rtfd',
      'Old.APP',
    ])
      expect(isSkippedFolderName(name), name).toBe(true);
  });

  it('keeps ordinary folder names, build and dist included', () => {
    for (const name of ['build', 'dist', 'src', 'Reports', 'app', 'keys', 'node', 'pycache', 'Apps and tools'])
      expect(isSkippedFolderName(name), name).toBe(false);
  });

  it('reads no file inside a skipped folder, at any depth, but reads a linked folder whatever its name', () => {
    expect(isIndexable(at('repo', '.git', 'notes.md'), root)).toBe(false);
    expect(isIndexable(at('repo', 'node_modules', 'pkg', 'README.md'), root)).toBe(false);
    expect(isIndexable(at('Tool.app', 'Contents', 'Resources', 'help.pdf'), root)).toBe(false);
    expect(isIndexable(at('build', 'report.pdf'), root)).toBe(true);
    expect(isIndexable('/x/node_modules/guide.md', '/x/node_modules')).toBe(true);
  });

  it('finds a Python virtual environment by its pyvenv.cfg', () => {
    const env = path.join(tmp, 'project', 'env');
    fs.mkdirSync(path.join(env, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(env, 'pyvenv.cfg'), 'home = /usr/bin\n');
    expect(isVenvFolder(env)).toBe(true);
    expect(isVenvFolder(path.join(tmp, 'project'))).toBe(false);
    expect(isOutsideRules(path.join(env, 'lib', 'LICENSE.txt'), tmp)).toBe(true);
    expect(isOutsideRules(path.join(tmp, 'project', 'plan.md'), tmp)).toBe(false);
  });

  it('tells which indexed files the current rules would not read', () => {
    expect(isOutsideRules(at('table.csv'), root)).toBe(true);
    expect(isOutsideRules(at('repo', 'node_modules', 'a', 'README.md'), root)).toBe(true);
    expect(isOutsideRules(at('Talk.key', 'preview.pdf'), root)).toBe(true);
    expect(isOutsideRules(at('notes', 'plan.md'), root)).toBe(false);
  });
});
