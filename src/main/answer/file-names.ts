/**
 * Names of files in answer text (docs/plan.md, round N2). The model copies the file names and
 * display names it reads in the question and the source headers into its sentences; these helpers
 * take whole names out, never single words (Procurement, Guidance, 采购 and 招标 stay).
 */

/** A file name in backticks: `01_Procurement_Regulations_2025.pdf`. */
const BACKTICKED_FILE = /`[^`\s]+\.[A-Za-z0-9]{1,5}`/g;

/** Spaces and brackets left behind after a name is taken out of a sentence. */
function tidy(text: string): string {
  return text
    .replace(/\(\s*\)|（\s*）/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?，。；：！？)）])/g, '$1')
    .replace(/(^|\n)[ \t]+/g, '$1');
}

/**
 * dropAnswerFileNames: the answer text without backticked file names; display names stay.
 * changed is false when there was none.
 */
export function dropBacktickedFileNames(text: string): { text: string; changed: boolean } {
  if (!BACKTICKED_FILE.test(text)) return { text, changed: false };
  BACKTICKED_FILE.lastIndex = 0;
  return { text: tidy(text.replace(BACKTICKED_FILE, '')), changed: true };
}

const CJK = /[㐀-鿿]/;

function escape(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The phrases verifyStripNames takes out of a sentence before its overlap is measured: every
 * display name whole, and for a Chinese one its title-mark forms 《display name》 and, when the
 * name carries a year or version after a space, 《name without it》 (《标准设备采购招标文件》
 * for 标准设备采购招标文件 2017年版), the form questions and answers write.
 */
export function namePhrases(displayNames: string[]): RegExp[] {
  const out: RegExp[] = [BACKTICKED_FILE];
  const seen = new Set<string>();
  for (const name of [...new Set(displayNames)].sort((a, b) => b.length - a.length)) {
    if (!name.trim() || seen.has(name)) continue;
    seen.add(name);
    if (CJK.test(name)) {
      const head = name.split(' ')[0]!;
      for (const t of new Set([name, head])) out.push(new RegExp(`《\\s*${escape(t)}\\s*》`, 'g'));
      out.push(new RegExp(escape(name), 'g'));
    } else {
      const words = name.split(/\s+/).map(escape).join('\\s+');
      out.push(new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'giu'));
    }
  }
  return out;
}

/** verifyStripNames: the sentence without the phrases; changed is false when none occurred. */
export function stripNames(sentence: string, phrases: RegExp[]): { text: string; changed: boolean } {
  let text = sentence;
  for (const re of phrases) {
    re.lastIndex = 0;
    text = text.replace(re, ' ');
  }
  return text === sentence ? { text, changed: false } : { text: tidy(text), changed: true };
}
