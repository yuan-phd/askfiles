import { describe, expect, it } from 'vitest';
import { porterStem, stemFolded, WORD_MARK } from './stem.js';

describe('Porter stemmer', () => {
  // The examples of Porter's paper (1980), step by step, and the reference output for common words.
  const cases: [string, string][] = [
    ['caresses', 'caress'],
    ['ponies', 'poni'],
    ['ties', 'ti'],
    ['caress', 'caress'],
    ['cats', 'cat'],
    ['feed', 'feed'],
    ['agreed', 'agre'],
    ['plastered', 'plaster'],
    ['bled', 'bled'],
    ['motoring', 'motor'],
    ['sing', 'sing'],
    ['conflated', 'conflat'],
    ['troubled', 'troubl'],
    ['sized', 'size'],
    ['hopping', 'hop'],
    ['tanned', 'tan'],
    ['falling', 'fall'],
    ['hissing', 'hiss'],
    ['fizzed', 'fizz'],
    ['failing', 'fail'],
    ['filing', 'file'],
    ['happy', 'happi'],
    ['sky', 'sky'],
    ['relational', 'relat'],
    ['conditional', 'condit'],
    ['rational', 'ration'],
    ['valenci', 'valenc'],
    ['digitizer', 'digit'],
    ['conformabli', 'conform'],
    ['radicalli', 'radic'],
    ['differentli', 'differ'],
    ['vileli', 'vile'],
    ['analogousli', 'analog'],
    ['vietnamization', 'vietnam'],
    ['predication', 'predic'],
    ['operator', 'oper'],
    ['feudalism', 'feudal'],
    ['decisiveness', 'decis'],
    ['hopefulness', 'hope'],
    ['callousness', 'callous'],
    ['formaliti', 'formal'],
    ['sensitiviti', 'sensit'],
    ['sensibiliti', 'sensibl'],
    ['triplicate', 'triplic'],
    ['formative', 'form'],
    ['formalize', 'formal'],
    ['electriciti', 'electr'],
    ['electrical', 'electr'],
    ['hopeful', 'hope'],
    ['goodness', 'good'],
    ['revival', 'reviv'],
    ['allowance', 'allow'],
    ['inference', 'infer'],
    ['airliner', 'airlin'],
    ['gyroscopic', 'gyroscop'],
    ['adjustable', 'adjust'],
    ['defensible', 'defens'],
    ['irritant', 'irrit'],
    ['replacement', 'replac'],
    ['adjustment', 'adjust'],
    ['dependent', 'depend'],
    ['adoption', 'adopt'],
    ['homologou', 'homolog'],
    ['communism', 'commun'],
    ['activate', 'activ'],
    ['angulariti', 'angular'],
    ['homologous', 'homolog'],
    ['effective', 'effect'],
    ['bowdlerize', 'bowdler'],
    ['probate', 'probat'],
    ['rate', 'rate'],
    ['cease', 'ceas'],
    ['controlling', 'control'],
    ['roll', 'roll'],
    ['generalizations', 'gener'],
    ['oscillators', 'oscil'],
    // The words of a keyword diagnosis and their neighbours.
    ['planning', 'plan'],
    ['plan', 'plan'],
    ['planned', 'plan'],
    ['plans', 'plan'],
    ['maintenance', 'mainten'],
    ['policies', 'polici'],
    ['policy', 'polici'],
    ['regulations', 'regul'],
    ['evaluating', 'evalu'],
    ['evaluation', 'evalu'],
  ];
  it.each(cases)('%s -> %s', (word, stem) => expect(porterStem(word)).toBe(stem));

  it('stems the English words of a folded text and leaves Chinese, digits and punctuation alone', () => {
    const m = (s: string) => `${WORD_MARK}${s}${WORD_MARK}`;
    expect(stemFolded('maintenance planning')).toBe(`${m('mainten')} ${m('plan')}`);
    expect(stemFolded('4.6 the maintenance plan, 维修计划')).toBe(
      `4.6 ${m('the')} ${m('mainten')} ${m('plan')}, 维修计划`,
    );
    expect(stemFolded('iso-9001')).toBe(`${m('iso')}-9001`);
    // Whole words only: a stemmed term never matches inside a longer word.
    expect(stemFolded('the planet').includes(stemFolded('plan'))).toBe(false);
    expect(stemFolded('the maintenance plan').includes(stemFolded('maintenance planning'))).toBe(true);
  });
});
