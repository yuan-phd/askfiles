// Answers rendered as Markdown on the Ask page (src/renderer/shared/markdown.js): lists, bold in a
// list item, a citation inside a list item, the dagger at the end of a list item, streaming
// without half-rendered markers, and HTML or a link shown as text. Answers are invented.
import { test, expect } from '@playwright/test';
import { answerRun, card, mockLibrary, pageUrl, partsOf, stubAnswer } from './mocks.js';

const SUN = card(1, { title: 'Sun', path: ['Garden guide', 'Sun'], passage: 'Tomatoes need full sun.' });
const SOIL = card(2, { title: 'Soil', path: ['Garden guide', 'Soil'], passage: 'Basil likes warm soil.' });

const DAGGER = '\u2020';

async function ask(page, question, run) {
  await mockLibrary(page);
  await stubAnswer(page, { runs: { [question]: run } });
  await page.goto(pageUrl());
  await page.getByTestId('query').fill(question);
  await page.getByTestId('query').press('Enter');
}

// The streamed reply and the claims the pipeline makes of it (claimsOf: text without Markdown,
// markdown as written).
const REPLY = [
  'Three plants:\n',
  '* **Tomatoes**: full sun [1].\n',
  '* **Basil**: warm soil [2].\n',
  '  1. Pinch it *often*.\n',
  '  2. Use `pot-12` pots.\n',
  '* **Mint**: grows anywhere.',
];
const CLAIMS = [
  { text: 'Three plants:\n', citations: [], unsupported: false, leadIn: true },
  { text: 'Tomatoes: full sun .\n', markdown: '* **Tomatoes**: full sun .\n', citations: [1], unsupported: false },
  { text: 'Basil: warm soil .\n', markdown: '* **Basil**: warm soil .\n', citations: [2], unsupported: false },
  { text: '  Pinch it often.\n', markdown: '  1. Pinch it *often*.\n', citations: [], unsupported: true },
  { text: '  Use pot-12 pots.\n', markdown: '  2. Use `pot-12` pots.\n', citations: [], unsupported: true },
  { text: 'Mint: grows anywhere.', markdown: '* **Mint**: grows anywhere.', citations: [], unsupported: true },
];
const listRun = (deltas = [partsOf(REPLY.join(''))]) =>
  answerRun({ sources: [SUN, SOIL], deltas, result: { claims: CLAIMS, cited: [SUN, SOIL] } });

test.describe('Markdown answers', () => {
  test('lists render as lists, nested, with bold, italic and code', async ({ page }) => {
    await ask(page, 'What do the plants need?', listRun());
    const answer = page.getByTestId('answer-text');
    await expect(answer.getByTestId('unsupported-mark')).toHaveCount(3);
    await expect(answer.locator(':scope > p')).toHaveText('Three plants:');
    await expect(answer.locator(':scope > ul > li')).toHaveCount(3);
    await expect(answer.locator('ul > li > ol > li')).toHaveCount(2);
    await expect(answer.locator(':scope > ul > li > strong')).toHaveText(['Tomatoes', 'Basil', 'Mint']);
    await expect(answer.locator('ol em')).toHaveText('often');
    await expect(answer.locator('ol code')).toHaveText('pot-12');
    // No Markdown syntax is left in the text.
    expect(await answer.textContent()).not.toMatch(/[*`]/);
  });

  test('a citation inside a list item opens its source card', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 420 });
    await ask(page, 'What do the plants need?', listRun());
    const cite = page.getByTestId('answer-text').locator('ul > li').nth(1).getByTestId('cite').first();
    await expect(cite).toHaveText('[2]');
    await expect(page.locator('#source-2')).not.toBeInViewport();
    await cite.click();
    await expect(page.locator('#source-2')).toBeInViewport();
  });

  test('the dagger ends an unsupported list item: larger, muted, with the note as its tooltip', async ({ page }) => {
    await ask(page, 'What do the plants need?', listRun());
    const item = page.getByTestId('answer-text').locator(':scope > ul > li').nth(2);
    await expect(item).toHaveText(`Mint: grows anywhere.${DAGGER}`);
    const mark = item.getByTestId('unsupported-mark');
    await expect(mark).toHaveText(DAGGER);
    await expect(mark).toHaveAttribute('title', /^Sentences marked \u2020 have no word-for-word support/);
    const style = await mark.evaluate((el) => {
      const s = window.getComputedStyle(el);
      const body = window.getComputedStyle(el.closest('li'));
      return {
        // Nothing but whitespace after the dagger in its list item.
        last: (() => {
          const range = document.createRange();
          range.setStartAfter(el);
          range.setEndAfter(el.closest('li'));
          return range.toString().trim() === '';
        })(),
        size: parseFloat(s.fontSize) / parseFloat(body.fontSize),
        weight: s.fontWeight,
        color: s.color,
        muted: window.getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim(),
      };
    });
    expect(style.last).toBe(true);
    expect(style.size).toBeGreaterThan(1.05);
    expect(style.size).toBeLessThan(1.3);
    expect(style.weight).toBe('400');
    expect(style.color).toBe(hexToRgb(style.muted));
    // The dagger is no Markdown: the item is still one item, and its bold is still bold.
    await expect(item.locator('strong')).toHaveText('Mint');
    await expect(page.getByTestId('answer-note')).toHaveText(
      `Sentences marked ${DAGGER} have no word-for-word support in the sources. They may be a summary or conclusion drawn from the sources, or they may be inaccurate. Check them against the source cards.`,
    );
  });

  test('streams without half-rendered markers or flicker', async ({ page }) => {
    // The reply cut at the awkward places: inside **, after a list marker, inside a code span.
    const text = REPLY.join('');
    const cuts = [0, 15, 16, 17, 19, 22, 30, 50, 52, 70, 80, 91, 100, 110, 120, text.length];
    const deltas = cuts.slice(1).map((end, k) => partsOf(text.slice(cuts[k], end)));
    await page.addInitScript(() => {
      window.__frames = [];
      const watch = () => {
        const el = document.getElementById('answer-text');
        if (!el) return window.requestAnimationFrame(watch);
        new window.MutationObserver(() =>
          window.__frames.push({ text: el.textContent, strong: el.querySelectorAll('strong').length }),
        ).observe(el, { childList: true, subtree: true, characterData: true });
      };
      document.addEventListener('DOMContentLoaded', watch);
    });
    await ask(page, 'What do the plants need?', listRun(deltas));
    await expect(page.getByTestId('unsupported-mark')).toHaveCount(3);
    const frames = await page.evaluate(() => window.__frames.filter((f) => f.text));
    const streamed = frames.filter((f) => !f.text.includes(DAGGER));
    expect(streamed.length).toBeGreaterThan(8);
    for (const [k, f] of streamed.entries()) {
      expect(f.text, `frame ${k}`).not.toMatch(/[*`]/);
      // Text only grows, and bold once shown stays bold.
      if (k) {
        expect(f.text.startsWith(streamed[k - 1].text), `frame ${k}`).toBe(true);
        expect(f.strong).toBeGreaterThanOrEqual(streamed[k - 1].strong);
      }
    }
    // The finished answer has the same words as the end of the stream, plus the daggers. (Its
    // citations stand after the sentence's full stop, as before Markdown.)
    const words = (t) => t.replaceAll(DAGGER, '').replace(/\[\d+\]|\s+/g, '');
    expect(words(frames.at(-1).text)).toBe(words(streamed.at(-1).text));
  });

  test('HTML and links in an answer are shown as text, and nothing runs or loads', async ({ page }) => {
    const reply =
      'See <img src="https://example.invalid/x.png" onerror="window.__ran=1"> and [the guide](https://example.invalid/guide) ' +
      'or <script>window.__ran=2</script> ![photo](https://example.invalid/p.png) # not a heading.';
    const loads = [];
    page.on('request', (r) => {
      if (r.url().includes('example.invalid')) loads.push(r.url());
    });
    const run = answerRun({
      sources: [SUN],
      deltas: [partsOf(reply)],
      result: { claims: [{ text: reply, citations: [1], unsupported: false }], cited: [SUN] },
    });
    await ask(page, 'Any links?', run);
    const answer = page.getByTestId('answer-text');
    await expect(answer.getByTestId('cite')).toHaveCount(1);
    await expect(answer).toContainText('<img src="https://example.invalid/x.png" onerror="window.__ran=1">');
    await expect(answer).toContainText('[the guide](https://example.invalid/guide)');
    await expect(answer).toContainText('<script>window.__ran=2</script>');
    await expect(answer.locator('img, script, iframe, a:not(.cite), h1, h2, h3')).toHaveCount(0);
    expect(await page.evaluate(() => window.__ran ?? null)).toBeNull();
    expect(loads).toEqual([]);
  });

  test('a Chinese list with bold after Chinese punctuation', async ({ page }) => {
    const claims = [
      { text: '要求如下：\n', citations: [], unsupported: false, leadIn: true },
      { text: '光照：全日照 \n', markdown: '1. **光照：**全日照 \n', citations: [1], unsupported: false },
      { text: '土壤：温暖', markdown: '2. **土壤：**温暖', citations: [], unsupported: true },
    ];
    const run = answerRun({
      sources: [SUN],
      deltas: [partsOf('要求如下：\n1. **光照：**全日照 [1]\n2. **土壤：**温暖')],
      result: { claims, cited: [SUN] },
    });
    await ask(page, '要求是什么？', run);
    const answer = page.getByTestId('answer-text');
    await expect(answer.locator('ol > li strong')).toHaveText(['光照：', '土壤：']);
    await expect(answer.locator('ol > li').nth(1)).toHaveText(`土壤：温暖${DAGGER}`);
    await expect(page.getByTestId('answer-note')).toHaveText(
      `带 ${DAGGER} 标记的句子在来源中没有逐字对应的原文，可能是根据来源归纳的结论，也可能不准确，请对照来源卡片核实。`,
    );
  });

  test('an unsupported sentence keeps the text colour; only the muted dagger marks it', async ({ page }) => {
    const claims = [
      { text: 'Tomatoes need full sun .', citations: [1], unsupported: false },
      { text: ' Mint grows anywhere .', citations: [], unsupported: true },
    ];
    const run = answerRun({
      sources: [SUN],
      deltas: [partsOf('Tomatoes need full sun [1]. Mint grows anywhere .')],
      result: { claims, cited: [SUN] },
    });
    await ask(page, 'Where do plants grow?', run);
    const answer = page.getByTestId('answer-text');
    await expect(answer).toHaveText(`Tomatoes need full sun.[1] Mint grows anywhere.${DAGGER}`);
    const colors = await answer.evaluate((el) => {
      const c = (x) => window.getComputedStyle(x).color;
      const root = window.getComputedStyle(document.documentElement);
      return {
        supported: c(el.querySelector('[data-testid=claim]')),
        unsupported: c(el.querySelector('[data-testid=claim-unsupported]')),
        mark: c(el.querySelector('[data-testid=unsupported-mark]')),
        text: root.getPropertyValue('--text').trim(),
        muted: root.getPropertyValue('--text-muted').trim(),
      };
    });
    expect(colors.unsupported).toBe(colors.supported);
    expect(colors.unsupported).toBe(hexToRgb(colors.text));
    expect(colors.mark).toBe(hexToRgb(colors.muted));
  });

  test('the Drawn from heading has the Show more chevron after its words, turned when closed', async ({ page }) => {
    const TOOLS = card(3, { title: 'Tools', path: ['Garden guide', 'Tools'], passage: 'A trowel and a hose.' });
    const run = answerRun({
      sources: [SUN, SOIL, TOOLS],
      deltas: [partsOf('Tomatoes need full sun [1]. Basil wants a trowel [2].')],
      result: {
        claims: [
          { text: 'Tomatoes need full sun . ', citations: [1], unsupported: false },
          { text: 'Basil wants a trowel .', citations: [], unsupported: true },
        ],
        cited: [SUN],
        considered: [SOIL, TOOLS],
        drawnFrom: [SOIL],
      },
    });
    await ask(page, 'What tools?', run);
    const drawn = page.getByTestId('drawn-title');
    await expect(drawn).toHaveText('Drawn from, not word for word ⌃');
    const chevron = drawn.locator('.chevron');
    const other = page.getByTestId('considered-title').locator('.chevron');
    await expect(chevron).toHaveClass('chevron');
    await expect(chevron).toHaveAttribute('aria-hidden', 'true');
    // The same chevron as Show N more sections (and Compare's Show more): glyph, size, weight, lift,
    // both open.
    await page.getByTestId('considered-title').click();
    await expect(other).toHaveClass('chevron');
    for (const prop of ['font-size', 'font-weight', 'transform'])
      await expect(chevron).toHaveCSS(
        prop,
        await other.evaluate((e, p) => window.getComputedStyle(e).getPropertyValue(p), prop),
      );
    await expect(chevron).toHaveText(await other.textContent());
    // No browser triangle before the words, and the heading keeps its own style.
    const heading = await drawn.evaluate((s) => ({
      marker: window.getComputedStyle(s).listStyleType,
      first: s.firstChild.textContent.trim().slice(0, 4),
      transform: window.getComputedStyle(s).textTransform,
      size: window.getComputedStyle(s).fontSize,
    }));
    expect(heading).toEqual({ marker: 'none', first: 'Draw', transform: 'uppercase', size: '12.8px' });
    // Closed: the same glyph turned, the group's cards hidden.
    await drawn.click();
    await expect(chevron).toHaveClass('chevron down');
    await expect(page.getByTestId('drawn').getByTestId('source-card')).toBeHidden();
    await drawn.click();
    await expect(chevron).toHaveClass('chevron');
  });
});

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
