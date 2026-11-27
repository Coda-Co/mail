// The spelling dictionary for this window: Hunspell (via nspell) for the chosen
// English, plus the user's own words (saved in settings) and words ignored for
// this session. Loaded on first use so it stays out of the start-up bundle.
import type { Checker } from './spelling';

export type SpellingLanguage = 'en-GB' | 'en-US';

interface Loaded {
  correct(word: string): boolean;
  suggest(word: string): string[];
}

const loading = new Map<SpellingLanguage, Promise<Loaded>>();

function load(lang: SpellingLanguage): Promise<Loaded> {
  let p = loading.get(lang);
  if (!p) {
    p = (async () => {
      const [{ default: nspell }, aff, dic] = await Promise.all(
        lang === 'en-US'
          ? [import('nspell'), import('@dictionary/en-US/index.aff?raw'), import('@dictionary/en-US/index.dic?raw')]
          : [import('nspell'), import('@dictionary/en-GB/index.aff?raw'), import('@dictionary/en-GB/index.dic?raw')],
      );
      return nspell(aff.default, dic.default);
    })();
    // A failed load (it shouldn't) can be tried again next time.
    p.catch(() => loading.delete(lang));
    loading.set(lang, p);
  }
  return p;
}

const own = new Set<string>();
const ignored = new Set<string>();
const listeners = new Set<() => void>();

function changed() {
  listeners.forEach((l) => l());
}

/** Called when the dictionary or the user's words change, so editors can recheck. */
export function onDictionaryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The user's own words, from settings. */
export function setOwnWords(words: string[]): void {
  const next = words.map((w) => w.toLowerCase());
  if (next.length === own.size && next.every((w) => own.has(w))) return;
  own.clear();
  next.forEach((w) => own.add(w));
  changed();
}

/** Leave a word alone in this window until the app restarts. */
export function ignoreWord(word: string): void {
  ignored.add(word.toLowerCase());
  changed();
}

/** A checker for the language, once its dictionary has loaded. */
export async function checkerFor(lang: SpellingLanguage): Promise<Checker> {
  const base = await load(lang);
  const known = (w: string) => {
    const lower = w.toLowerCase();
    return own.has(lower) || ignored.has(lower);
  };
  return {
    correct: (w) => known(w) || base.correct(w),
    suggest: (w) => base.suggest(w),
  };
}
