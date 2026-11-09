// The Markdown source the Ask page renders an answer from (../shared/markdown.js renderMarkdown).
// Citations and the unsupported marker go in as private-use characters, each mapped to the
// function that makes its node, so lists and bold text hold them and their own characters never
// read as Markdown: a dagger is not a list marker and no asterisk pairs with the model's own.

/** The unsupported-sentence marker, a dagger. */
export const MARKER = '\u2020';

const FIRST = 0xe000;
const PRIVATE_USE = /[\ue000-\uf8ff]/g;

function placeholders() {
  const nodes = new Map();
  return {
    nodes,
    add(make) {
      const ch = String.fromCharCode(FIRST + nodes.size);
      nodes.set(ch, make);
      return ch;
    },
  };
}

/** The streamed parts as one source: text as it came, a placeholder for each citation (cite(n) makes its node). */
export function streamingSource(parts, cite) {
  const ph = placeholders();
  const src = parts
    .map((p) => (p.type === 'cite' ? ph.add(() => cite(p.n)) : p.text.replace(PRIVATE_USE, '')))
    .join('');
  return { src, nodes: ph.nodes };
}

// The sentence's closing punctuation, and what may stand between it and the last word: spaces
// and emphasis delimiters (**Water weekly** .), or after it (**Water weekly .**).
const CLOSING = /^([\s\S]*?\S)([\s*_]*)([.!?\u3002\uff01\uff1f:\uff1a;\uff1b,\uff0c\u2026]+)([*_]*)$/;

/**
 * A sentence's text with no space before its closing punctuation. The model often writes the
 * citation before the full stop (sun [1].), and taking the citation out to place it after the
 * sentence leaves sun . behind; the display closes that gap. Display only: the stored claim and
 * verification keep the text as it was.
 */
export function tightEnd(body) {
  const m = CLOSING.exec(body);
  return m ? m[1] + m[2].replace(/\s+/g, '') + m[3] + m[4] : body;
}

/**
 * The finished claims as one source. Each claim's Markdown (else its text) without its trailing
 * whitespace and with its closing punctuation against its last word (tightEnd), then its
 * citations, then the marker when unsupported, then the whitespace: text, punctuation, [n], dagger
 * (Water weekly.[2], spreads fast.\u2020), on the same line, inside its list item, and after the
 * closing ** of a sentence in bold. spans gives each claim's stretch, for the sentence spans.
 */
export function claimsSource(claims, { cite, mark, span }) {
  const ph = placeholders();
  const spans = [];
  let src = '';
  claims.forEach((c, i) => {
    const text = (c.markdown ?? c.text).replace(PRIVATE_USE, '');
    const from = src.length;
    src += tightEnd(text.replace(/\s+$/, ''));
    for (const n of c.citations) src += ph.add(() => cite(n));
    if (c.unsupported) src += ph.add(() => mark());
    src += /\s+$/.exec(text)?.[0] ?? ' ';
    spans.push({ from, to: src.length, make: (first) => span(c, i, first) });
  });
  return { src, nodes: ph.nodes, spans };
}
