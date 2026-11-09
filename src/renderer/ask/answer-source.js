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

/**
 * The finished claims as one source. Each claim's Markdown (else its text) without its trailing
 * whitespace, then its citations, then the marker when unsupported, then the whitespace: so the
 * dagger follows the sentence's last word on the same line, inside its list item, and after the
 * closing ** of a sentence in bold. spans gives each claim's stretch, for the sentence spans.
 */
export function claimsSource(claims, { cite, mark, span }) {
  const ph = placeholders();
  const spans = [];
  let src = '';
  claims.forEach((c, i) => {
    const text = (c.markdown ?? c.text).replace(PRIVATE_USE, '');
    const from = src.length;
    src += text.replace(/\s+$/, '');
    for (const n of c.citations) src += ph.add(() => cite(n));
    if (c.unsupported) src += ph.add(() => mark());
    src += /\s+$/.exec(text)?.[0] ?? ' ';
    spans.push({ from, to: src.length, make: (first) => span(c, i, first) });
  });
  return { src, nodes: ph.nodes, spans };
}
