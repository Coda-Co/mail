// Spelling logic with no DOM: finding words, deciding which to check, ranking
// suggestions and deciding when a typo is safe to correct as you type. The
// dictionary itself (Hunspell, through nspell) is loaded by lib/dictionary.ts.

export interface Checker {
  correct(word: string): boolean;
  suggest(word: string): string[];
}

export interface Token {
  word: string;
  start: number;
  end: number;
}

const LETTER = /\p{L}/u;
const APOSTROPHE = /['’]/;

/** Characters that end a word as you type it, and so may trigger a correction. */
export const BOUNDARY = /^[\s .,!?;:)\]}"”…]$/;

/**
 * The words in a run of text, with their offsets. Apostrophes inside a word
 * belong to it (don't, it’s); hyphens split it, so each half is checked on its
 * own. Words inside addresses, links, hashtags and the like are left out.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const masked = maskUnchecked(text);
  let i = 0;
  while (i < masked.length) {
    if (!LETTER.test(masked[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < masked.length && (LETTER.test(masked[j]) || (APOSTROPHE.test(masked[j]) && j + 1 < masked.length && LETTER.test(masked[j + 1])))) j++;
    // A word glued to digits or underscores (v2beta, foo_bar) is code or an id, not prose.
    const glued = /[\d_]/.test(masked[i - 1] ?? '') || /[\d_]/.test(masked[j] ?? '');
    if (!glued) out.push({ word: text.slice(i, j), start: i, end: j });
    i = j;
  }
  return out;
}

/** Blank out things that aren't prose: emails, links, @mentions, #tags, paths. */
function maskUnchecked(text: string): string {
  return text.replace(/\S+@\S+|\b(?:https?:\/\/|www\.)\S+|[@#]\S+|\S*[/\\]\S+|\S+\.(?:com|org|net|io|co|uk|dev|app)\b\S*/giu, (m) => ' '.repeat(m.length));
}

/** Whether the word starts a sentence: nothing but space and opening quotes since .!? or the start. */
export function startsSentence(text: string, start: number): boolean {
  for (let i = start - 1; i >= 0; i--) {
    const c = text[i];
    if (/[\s "'“‘(\[]/.test(c)) continue;
    return /[.!?…]/.test(c);
  }
  return true;
}

/** Abbreviations whose full stop rarely ends a sentence, lower case, without the last stop. */
const ABBREVIATIONS = new Set(['e.g', 'eg', 'i.e', 'ie', 'etc', 'vs', 'cf', 'approx', 'incl', 'esp', 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'fig', 'pp', 'a.m', 'p.m', 'ca', 'viz']);

/**
 * Whether a word should get a capital as the first of a sentence. `before` is
 * the text ahead of it in the same paragraph, with line breaks as \n. Stricter
 * than startsSentence: when in doubt (an abbreviation, an initial, an
 * ellipsis, a list marker) it says no, so a word is only ever changed when
 * the sentence clearly starts there. A new line counts, so the line after
 * "Hi Sam," starts with a capital.
 */
export function capitalisesAfter(before: string): boolean {
  let s = before.replace(/["'“‘(\[]+$/u, '');
  if (s.trim() === '') return true;
  const gap = s.match(/\s+$/u);
  if (!gap) return false;
  if (gap[0].includes('\n')) return true;
  s = s.slice(0, -gap[0].length).replace(/[)\]"'”’]+$/u, '');
  const last = s[s.length - 1];
  if (last === '!' || last === '?') return true;
  if (last !== '.') return false;
  const word = s.slice(0, -1).match(/(\S*)$/u)![1].replace(/^["'“‘(\[]+/u, '');
  if (word.endsWith('.') || word === '') return false; // an ellipsis, or a stray stop
  if (/^\p{L}$/u.test(word)) return false; // an initial: J. Smith
  return !ABBREVIATIONS.has(word.toLowerCase());
}

/** The word with a capital, if it is plain lower case (not iPhone, eBay or a lone I). */
export function capitalised(word: string): string | null {
  const first = word[0];
  if (!first || first === first.toUpperCase() || word !== word.toLowerCase()) return null;
  return first.toUpperCase() + word.slice(1);
}

/** Days and months, which take a capital anywhere. Not may, march, sat, sun or wed, which are words too. */
const DAYS_AND_MONTHS = new Set(
  'monday tuesday wednesday thursday friday saturday sunday mon tue tues thu thur thurs fri january february april june july august september october november december jan feb apr jun jul aug sept oct nov dec'.split(' '),
);

/** The capital a finished lower-case word should get here, if any: as the first of a sentence, or a day or month. */
export function capitalFor(word: string, before: string): string | null {
  const fixed = capitalised(word);
  if (!fixed) return null;
  return DAYS_AND_MONTHS.has(word) || capitalisesAfter(before) ? fixed : null;
}

/**
 * The word a typed boundary finishes, with the caret at `at`. Usually it ends at
 * the caret; after "ok." (or "ok.)") and a space it ends before the stop, which
 * is how a word ended by a stop gets its capital (the stop itself never gives
 * one, or example.com would). Null unless it's a whole word on its own: not part
 * of an address, a number or a path.
 */
export function finishedWord(text: string, at: number, boundary: string): { word: string; start: number; end: number; afterStop: boolean } | null {
  let end = at;
  if (/\s/.test(boundary)) {
    const tail = text.slice(0, end).match(/[.)\]"'”’]+$/u)?.[0] ?? '';
    if (tail.includes('.')) end -= tail.length;
  }
  const afterStop = end < at;
  let start = end;
  while (start > 0 && /[\p{L}'’]/u.test(text[start - 1])) start--;
  const word = text.slice(start, end).replace(/^['’]+/, '');
  start = end - word.length;
  if (!word || /[\p{L}\d]/u.test(text[end] ?? '') || /[\d@/\\._#-]/.test(text[start - 1] ?? '')) return null;
  if (afterStop && /[\p{L}\d]/u.test(text[end + 1] ?? '')) return null;
  return { word, start, end, afterStop };
}

/**
 * "THanks" (Shift held a moment too long) or "tHANKS" (Caps Lock on) as the word
 * meant, when that is a word. Acronyms with an s (IDs, URLs), short mixed-case
 * names (iOS) and brands whose fix isn't a word (OAuth, VMware) don't match.
 */
export function capsSlip(word: string, checker: Checker): string | null {
  let fixed: string | null = null;
  if (/^\p{Lu}{2}[\p{Ll}'’]{2,}$/u.test(word)) fixed = word[0] + word.slice(1).toLowerCase();
  else if (/^\p{Ll}[\p{Lu}'’]{3,}$/u.test(word)) fixed = word[0].toUpperCase() + word.slice(1).toLowerCase();
  if (!fixed) return null;
  // Hunspell is loose about case and calls THanks correct, so only the fix is looked up.
  const plain = fixed.replace(/’/g, "'");
  return checker.correct(plain) || checker.correct(plain.toLowerCase()) ? fixed : null;
}

/**
 * Whether a word is worth checking. Leaves out single letters, acronyms and
 * mixed case (KPI, iPhone, McDonald), and capitalised words in the middle of a
 * sentence, which are usually names the dictionary has never heard of.
 */
export function shouldCheck(word: string, atSentenceStart: boolean): boolean {
  const bare = stripApostrophes(word);
  if (bare.length < 2) return false;
  const rest = bare.slice(1);
  if (rest !== rest.toLowerCase()) return false;
  const capitalised = bare[0] !== bare[0].toLowerCase();
  if (capitalised && !atSentenceStart) return false;
  return true;
}

function stripApostrophes(word: string): string {
  return word.replace(/['’]+$/, '');
}

/** Apply the case pattern of `like` (lower, Capitalised or UPPER) to `word`. */
export function matchCase(word: string, like: string): string {
  if (like.length > 1 && like === like.toUpperCase() && like !== like.toLowerCase()) return word.toUpperCase();
  if (like[0] && like[0] !== like[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** Common typos, corrected as you type. Only ones that are never real words. */
export const TYPOS: Record<string, string> = {
  i: 'I',
  im: 'I’m',
  ive: 'I’ve',
  "i'm": 'I’m',
  'i’m': 'I’m',
  "i've": 'I’ve',
  'i’ve': 'I’ve',
  "i'll": 'I’ll',
  'i’ll': 'I’ll',
  "i'd": 'I’d',
  'i’d': 'I’d',
  dont: 'don’t',
  doesnt: 'doesn’t',
  didnt: 'didn’t',
  isnt: 'isn’t',
  wasnt: 'wasn’t',
  arent: 'aren’t',
  werent: 'weren’t',
  couldnt: 'couldn’t',
  shouldnt: 'shouldn’t',
  wouldnt: 'wouldn’t',
  havent: 'haven’t',
  hasnt: 'hasn’t',
  hadnt: 'hadn’t',
  mustnt: 'mustn’t',
  youre: 'you’re',
  theyre: 'they’re',
  youve: 'you’ve',
  weve: 'we’ve',
  theyve: 'they’ve',
  youll: 'you’ll',
  theyll: 'they’ll',
  thats: 'that’s',
  theres: 'there’s',
  whos: 'who’s',
  itll: 'it’ll',
  shouldve: 'should’ve',
  couldve: 'could’ve',
  wouldve: 'would’ve',
  teh: 'the',
  hte: 'the',
  thw: 'the',
  adn: 'and',
  nad: 'and',
  taht: 'that',
  thta: 'that',
  tht: 'that',
  wiht: 'with',
  wtih: 'with',
  fo: 'of',
  ot: 'to',
  yuo: 'you',
  yoru: 'your',
  jsut: 'just',
  knwo: 'know',
  konw: 'know',
  waht: 'what',
  wnat: 'want',
  becasue: 'because',
  becuase: 'because',
  beacuse: 'because',
  recieve: 'receive',
  recieved: 'received',
  reciept: 'receipt',
  beleive: 'believe',
  acheive: 'achieve',
  wich: 'which',
  whcih: 'which',
  alot: 'a lot',
  untill: 'until',
  occured: 'occurred',
  occurence: 'occurrence',
  goverment: 'government',
  enviroment: 'environment',
  enviroments: 'environments',
  seperate: 'separate',
  seperately: 'separately',
  definately: 'definitely',
  definatly: 'definitely',
  tommorow: 'tomorrow',
  tommorrow: 'tomorrow',
  tomorow: 'tomorrow',
  accomodate: 'accommodate',
  accomodation: 'accommodation',
  calender: 'calendar',
  wierd: 'weird',
  thier: 'their',
  freind: 'friend',
  freinds: 'friends',
  neccessary: 'necessary',
  necesary: 'necessary',
  occassion: 'occasion',
  embarass: 'embarrass',
  existance: 'existence',
  independant: 'independent',
  begining: 'beginning',
  publically: 'publicly',
  succesful: 'successful',
  sucessful: 'successful',
  recomend: 'recommend',
  reccomend: 'recommend',
  adress: 'address',
  agian: 'again',
  aswell: 'as well',
  infact: 'in fact',
  thanx: 'thanks',
  thnaks: 'thanks',
  thansk: 'thanks',
  tahnks: 'thanks',
  regrads: 'regards',
  sincerly: 'sincerely',
  attatched: 'attached',
  attachement: 'attachment',
  attachements: 'attachments',
  meeitng: 'meeting',
  meetign: 'meeting',
  availible: 'available',
  avaliable: 'available',
  tempory: 'temporary',
  wednsday: 'Wednesday',
  wendsday: 'Wednesday',
  febuary: 'February',
};

/** One adjacent pair of letters swapped (recieve → receive). */
function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/** Same letters once doubled letters are undoubled and vowels treated alike. */
function skeleton(w: string): string {
  return w.replace(/[aeiouy]/g, 'a').replace(/(.)\1+/g, '$1');
}

/**
 * A "slip": the kind of mistake people make in a word they know, as opposed
 * to a word the dictionary simply doesn't have (backend, async). Swapped
 * letters, a doubled or undoubled letter, or the wrong vowel, with the first
 * letter right.
 */
export function isSlip(typed: string, candidate: string): boolean {
  const a = typed.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b || a[0] !== b[0] || /[\s'’-]/.test(b)) return false;
  return isTransposition(a, b) || skeleton(a) === skeleton(b);
}

/** Suggestions for a misspelt word, best first: known typos, then slips, then the rest. */
export function suggestionsFor(word: string, checker: Checker, limit = 4): string[] {
  const lower = word.toLowerCase();
  const known = TYPOS[lower];
  const raw = checker.suggest(word);
  const ranked = [...raw.filter((s) => isSlip(word, s)), ...raw.filter((s) => !isSlip(word, s))];
  const out: string[] = [];
  for (const s of known ? [known, ...ranked] : ranked) {
    // Keep a suggestion's own capitals (Wednesday, FYI); otherwise follow the typed word.
    const cased = s === s.toLowerCase() ? matchCase(s, word) : s;
    if (!out.includes(cased) && cased !== word) out.push(cased);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * The correction to make as a word is finished, or null to leave it alone.
 * Only near-certain fixes: a known typo, or a misspelling with exactly one
 * dictionary suggestion that is a slip (definately → definitely). Names,
 * acronyms and capitalised words mid-sentence are never touched. A slip of
 * Shift or Caps Lock (THanks, tHANKS) is put right.
 */
export function autocorrection(word: string, checker: Checker, atSentenceStart: boolean): string | null {
  const caps = capsSlip(word, checker);
  if (caps) return caps;
  const lower = word.toLowerCase();
  const known = TYPOS[lower];
  if (known) {
    // "i" and "im" are I and I'm wherever they are; other entries only as plain or sentence-start words.
    if (lower === 'i' || lower.startsWith('i’') || lower.startsWith("i'") || lower === 'im' || lower === 'ive') return word === known ? null : known;
    if (!shouldCheck(word, atSentenceStart) || checker.correct(word)) return null;
    const fixed = known === known.toLowerCase() ? matchCase(known, word) : known;
    return fixed === word ? null : fixed;
  }
  if (word.length < 4 || !shouldCheck(word, atSentenceStart) || checker.correct(word)) return null;
  const slips = checker.suggest(word).filter((s) => isSlip(word, s));
  if (slips.length !== 1) return null;
  return slips[0] === slips[0].toLowerCase() ? matchCase(slips[0], word) : slips[0];
}

/** The misspelt words in a run of text. */
export function misspellings(text: string, checker: Checker): Token[] {
  return tokenize(text).filter((t) => shouldCheck(t.word, startsSentence(text, t.start)) && !checker.correct(stripApostrophes(t.word)));
}
