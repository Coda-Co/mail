import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import nspell from 'nspell';
import { autocorrection, capitalFor, capitalisesAfter, capitalised, capsSlip, finishedWord, isSlip, misspellings, shouldCheck, startsSentence, suggestionsFor, tokenize, TYPOS, type Checker } from './spelling';

function load(pkg: string): Checker {
  const dir = new URL(`../../node_modules/${pkg}/`, import.meta.url);
  return nspell(readFileSync(new URL('index.aff', dir), 'utf8'), readFileSync(new URL('index.dic', dir), 'utf8'));
}
const gb = load('dictionary-en-gb');
const us = load('dictionary-en');

describe('tokenize', () => {
  it('finds words with their offsets, keeping apostrophes inside words', () => {
    expect(tokenize("Hi, it's me—don’t worry.")).toEqual([
      { word: 'Hi', start: 0, end: 2 },
      { word: "it's", start: 4, end: 8 },
      { word: 'me', start: 9, end: 11 },
      { word: 'don’t', start: 12, end: 17 },
      { word: 'worry', start: 18, end: 23 },
    ]);
  });

  it('leaves out addresses, links, mentions, paths and words glued to digits', () => {
    const words = tokenize('Mail teh@exmaple.com or see https://exmaple.org/teh and www.qwzx.com, @jdoe #tagz src/foo v2beta 3pm ok').map((t) => t.word);
    expect(words).toEqual(['Mail', 'or', 'see', 'and', 'ok']);
  });

  it('splits hyphenated words', () => {
    expect(tokenize('follow-up').map((t) => t.word)).toEqual(['follow', 'up']);
  });
});

describe('which words are checked', () => {
  it('skips single letters, acronyms, mixed case and mid-sentence names', () => {
    expect(shouldCheck('a', true)).toBe(false);
    expect(shouldCheck('KPI', false)).toBe(false);
    expect(shouldCheck('iPhone', false)).toBe(false);
    expect(shouldCheck('Rowland', false)).toBe(false);
    expect(shouldCheck('Teh', true)).toBe(true);
    expect(shouldCheck('recieve', false)).toBe(true);
  });

  it('knows where sentences start', () => {
    const text = 'Hi Sam. “Teh thing” is (Nearly) done';
    expect(startsSentence(text, 0)).toBe(true);
    expect(startsSentence(text, 3)).toBe(false);
    expect(startsSentence(text, text.indexOf('Teh'))).toBe(true);
    expect(startsSentence(text, text.indexOf('Nearly'))).toBe(false);
  });

  it('flags misspellings but not names, jargon caps or the other spelling of the word', () => {
    expect(misspellings('Hi Rowland, I recieved teh KPI report. Definately ok.', gb).map((t) => t.word)).toEqual(['recieved', 'teh', 'Definately', 'ok']);
    expect(misspellings('The colour of the organisation', gb)).toEqual([]);
    expect(misspellings('The colour of the organisation', us).map((t) => t.word)).toEqual(['colour', 'organisation']);
    expect(misspellings('The color', gb).map((t) => t.word)).toEqual(['color']);
  });
});

describe('suggestions', () => {
  it('puts known typos and slips first, in the typed case', () => {
    expect(suggestionsFor('thier', gb)[0]).toBe('their');
    expect(suggestionsFor('Recieve', gb)[0]).toBe('Receive');
    expect(suggestionsFor('teh', gb)[0]).toBe('the');
    expect(suggestionsFor('recieve', gb).length).toBeLessThanOrEqual(4);
  });
});

describe('autocorrection', () => {
  it('fixes known typos, keeping the case', () => {
    expect(autocorrection('teh', gb, false)).toBe('the');
    expect(autocorrection('Teh', gb, true)).toBe('The');
    expect(autocorrection('dont', gb, false)).toBe('don’t');
    expect(autocorrection('i', gb, false)).toBe('I');
    expect(autocorrection('im', gb, false)).toBe('I’m');
    expect(autocorrection('alot', gb, false)).toBe('a lot');
  });

  it('fixes slips with one clear answer', () => {
    expect(autocorrection('definatley', gb, false)).toBe(null); // two letters off and swapped: not a slip
    expect(autocorrection('acommodate', gb, false)).toBe('accommodate');
    expect(autocorrection('seperated', gb, false)).toBe('separated');
    expect(autocorrection('mispelled', gb, false)).toBe('misspelled');
  });

  it('leaves real words, jargon, names and shouting alone', () => {
    for (const w of ['the', 'backend', 'async', 'config', 'repo', 'webview', 'onboarding', 'timesheets', 'lol', 'thx']) expect(autocorrection(w, gb, false)).toBe(null);
    expect(autocorrection('Recieve', gb, false)).toBe(null);
    expect(autocorrection('TEH', gb, true)).toBe(null);
    expect(autocorrection('I', gb, false)).toBe(null);
  });

  it('only lists typos that are not words in either dictionary', () => {
    const always = new Set(['i', 'im', 'ive']);
    const words = Object.keys(TYPOS).filter((t) => !always.has(t) && !t.includes("'") && !t.includes('’') && (gb.correct(t) || us.correct(t)));
    expect(words).toEqual([]);
  });

  it('recognises slips', () => {
    expect(isSlip('recieve', 'receive')).toBe(true);
    expect(isSlip('untill', 'until')).toBe(true);
    expect(isSlip('calender', 'calendar')).toBe(true);
    expect(isSlip('backend', 'backed')).toBe(false);
    expect(isSlip('async', 'sync')).toBe(false);
    expect(isSlip('teh', 'ten')).toBe(false);
  });
});

describe('capitals at the start of sentences', () => {
  it('starts a sentence at the start, after . ! ? and on a new line', () => {
    for (const before of ['', '  ', '“', '(', 'Done. ', 'Really?  ', 'Great! "', 'Hi Sam,\n', 'Thanks.\n\n', 'It is (nearly) done.) ', 'He said “no.” ', '1. ']) {
      expect(capitalisesAfter(before)).toBe(true);
    }
  });

  it('leaves mid-sentence words, abbreviations, initials and ellipses alone', () => {
    for (const before of ['Hi ', 'Hi Sam, ', 'apples, e.g. ', 'pears etc. ', 'see Dr. ', 'J. ', 'well... ', 'well… ', 'it is example.', 'done.', '- ', 'cf. ', 'at 9 a.m. ']) {
      expect(capitalisesAfter(before)).toBe(false);
    }
  });

  it('capitalises plain lower-case words only', () => {
    expect(capitalised('thanks')).toBe('Thanks');
    expect(capitalised('don’t')).toBe('Don’t');
    expect(capitalised('a')).toBe('A');
    expect(capitalised('Thanks')).toBe(null);
    expect(capitalised('iPhone')).toBe(null);
    expect(capitalised('eBay')).toBe(null);
  });
});

describe('days, months and the word a boundary finishes', () => {
  it('capitalises days and months anywhere, but not the ones that are also words', () => {
    expect(capitalFor('monday', 'see you ')).toBe('Monday');
    expect(capitalFor('sept', 'back in ')).toBe('Sept');
    expect(capitalFor('june', '')).toBe('June');
    for (const w of ['may', 'march', 'sat', 'sun', 'wed']) expect(capitalFor(w, 'we ')).toBe(null);
    expect(capitalFor('may', 'Done. ')).toBe('May');
    expect(capitalFor('report', 'the ')).toBe(null);
  });

  it('finds the finished word, looking past a stop only once a space is typed', () => {
    expect(finishedWord('hi there', 8, ' ')).toEqual({ word: 'there', start: 3, end: 8, afterStop: false });
    expect(finishedWord('so ok.', 6, ' ')).toEqual({ word: 'ok', start: 3, end: 5, afterStop: true });
    expect(finishedWord('so ok.)', 7, ' ')?.word).toBe('ok');
    expect(finishedWord('so ok.', 6, ',')).toBe(null);
    expect(finishedWord('see example.com', 15, ' ')).toBe(null);
    expect(finishedWord('mail a@b', 8, ' ')).toBe(null);
    expect(finishedWord('so e.g.', 7, ' ')).toBe(null);
  });
});

describe('slips of Shift and Caps Lock', () => {
  it('puts them right when the fix is a word', () => {
    expect(capsSlip('THanks', gb)).toBe('Thanks');
    expect(capsSlip('tHANKS', gb)).toBe('Thanks');
    expect(capsSlip('WEdnesday', gb)).toBe('Wednesday');
    expect(autocorrection('THe', gb, true)).toBe(null); // too short to tell from an acronym
    expect(autocorrection('THanks', gb, false)).toBe('Thanks');
  });

  it('leaves acronyms, plurals of acronyms and mixed-case names alone', () => {
    for (const w of ['IDs', 'URLs', 'APIs', 'PDFs', 'iOS', 'mRNA', 'KPI', 'THANKS', 'PhD', 'McDonald', 'iPhone', 'eBay', 'OAuth', 'VMware', 'MHz', 'SQLite']) expect(capsSlip(w, gb)).toBe(null);
  });
});
