import { describe, expect, it } from 'vitest';
import { claimsOf, parseCitations } from '../../src/main/answer/index.js';
import { recordedReply, replayChat } from './rescore.js';

describe('rescore', () => {
  it('uses raw_answer when recorded, else the answer column', () => {
    expect(recordedReply({ raw_answer: 'raw [1].', answer: 'shown' })).toBe('raw [1].');
    expect(recordedReply({ answer: 'As written [1].' })).toBe('As written [1].');
  });

  it('rebuilds a reply whose hedges were dropped so it parses into the same sentences', () => {
    // claimsText writes the citation after the full stop; parsed as is, two sentences would join.
    const row = {
      answer: 'The tool is under Risk Analysis .[1] The last step is to allocate a risk owner .[1]',
      hedges_dropped: 'The page is not specified in the provided sources.',
    };
    const claims = claimsOf(parseCitations(recordedReply(row)), 1);
    expect(claims.map((c) => [c.text.trim(), c.citations])).toEqual([
      ['The page is not specified in the provided sources.', []],
      ['The tool is under Risk Analysis .', [1]],
      ['The last step is to allocate a risk owner .', [1]],
    ]);
  });

  it('replays a reply as the chat call', async () => {
    let text = '';
    const stats = await replayChat(() => ({ text: 'Hello [1].', promptTokens: 3, completionTokens: 4 }))(
      { model: 'm', messages: [], temperature: 0, contextLength: 1 },
      (t) => (text += t),
    );
    expect(text).toBe('Hello [1].');
    expect(stats).toEqual({ promptTokens: 3, completionTokens: 4 });
  });
});
