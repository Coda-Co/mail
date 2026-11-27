import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { BookPlus, EyeOff, Undo2 } from 'lucide-react';
import { checkerFor, ignoreWord, onDictionaryChange, type SpellingLanguage } from '../lib/dictionary';
import { autocorrection, BOUNDARY, capitalFor, capitalised, finishedWord, misspellings, startsSentence, suggestionsFor, type Checker } from '../lib/spelling';
import { useCommand } from '../lib/commands';
import { keyLabel, isMac } from '../lib/platform';
import { matches } from '../lib/shortcuts';

// Spell check and autocorrect for a contentEditable editor.
//
// Misspellings are drawn with the CSS Custom Highlight API, so the message's
// HTML is never touched: nothing to strip before saving or sending, and the
// browser's undo history stays the user's own. The word being typed is left
// alone until the caret leaves it. Where the API is missing (older WebKit),
// the web view's own spell check is used instead, and autocorrect still works.

export const highlightsSupported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

// One highlight per name for the whole document, shared by every editor in it.
const flaggedByEditor = new Map<HTMLElement, Range[]>();
const correctedByEditor = new Map<HTMLElement, Range[]>();

function paint(name: string, byEditor: Map<HTMLElement, Range[]>) {
  if (!highlightsSupported) return;
  const all = [...byEditor.values()].flat();
  if (all.length > 0) CSS.highlights.set(name, new Highlight(...all));
  else CSS.highlights.delete(name);
}

/** Signatures, quoted messages, links and code aren't checked. */
const SKIP = '[data-signature], [data-quote], a, code, pre, blockquote, [contenteditable="false"]';
const BLOCK = 'div, p, li, h1, h2, h3, h4, h5, h6, td, th';

function checkedTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const skip = n.parentElement?.closest(SKIP);
      return skip && root.contains(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

function blockOf(node: Node, root: HTMLElement): Element {
  const b = node.parentElement?.closest(BLOCK);
  return b && root.contains(b) ? b : root;
}

/**
 * Up to `max` characters of text before a point, in the same paragraph, with
 * line breaks and nested blocks as \n. Formatting splits text into several
 * nodes, so the node the caret is in alone can't say where a sentence starts.
 */
function textBefore(root: HTMLElement, node: Node, offset: number, max = 60): string {
  const block = blockOf(node, root);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let out = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return (out + (n as Text).data.slice(0, offset)).slice(-max);
    if (n.nodeType === Node.TEXT_NODE) out = (out + (n as Text).data).slice(-max);
    else if ((n as Element).matches(`br, ${BLOCK}`)) out = '\n';
  }
  return out;
}

function caret(): { node: Node; offset: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  return { node: sel.anchorNode!, offset: sel.anchorOffset };
}

function rangeAt(node: Node, start: number, end: number): Range {
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  return r;
}

function holds(r: Range, node: Node, offset: number): boolean {
  try {
    return r.startContainer === node && r.startOffset <= offset && offset <= r.endOffset;
  } catch {
    return false;
  }
}

/** Replace the text a range covers as if typed, so it joins the undo history and fires input. */
function replaceRange(r: Range, text: string) {
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand('insertText', false, text);
}

interface Correction {
  range: Range;
  original: string;
  corrected: string;
  /** When it was made: the mark shows for a moment, then only on click. */
  at: number;
  /** Only a capital at the start of a sentence: not marked, and undoing it ignores nothing. */
  capitalOnly?: boolean;
}

const MARK_MS = 3000;

type Card =
  | { kind: 'misspelt'; range: Range; word: string; suggestions: string[]; viaKeyboard: boolean }
  | { kind: 'corrected'; range: Range; correction: Correction; viaKeyboard: boolean };

export interface SpellingOptions {
  spellcheck: boolean;
  autocorrect: boolean;
  /** Capitalise the first word of a sentence when it's finished. */
  autocapitalize: boolean;
  language: SpellingLanguage;
  /** Save a word to the user's dictionary. */
  addWord: (word: string) => void;
}

/**
 * Wire spell check and autocorrect into the editor. Returns the suggestion card
 * to render, and whether the web view's own spell check should be on instead.
 */
export function useSpelling(editor: RefObject<HTMLDivElement>, opts: SpellingOptions) {
  const [checker, setChecker] = useState<Checker | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const flagged = useRef<{ range: Range; word: string }[]>([]);
  const corrections = useRef<Correction[]>([]);
  // Where the caret was after the last keystroke; the word there is still being typed.
  const typedAt = useRef<{ node: Node; offset: number } | null>(null);
  // The correction just made, undone by an immediate Backspace.
  const justCorrected = useRef<{ correction: Correction; node: Node; offset: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const active = opts.spellcheck || opts.autocorrect;
  useEffect(() => {
    if (!active) return;
    let live = true;
    // Load once the editor is up, so opening a draft stays instant.
    const t = setTimeout(() => {
      checkerFor(opts.language)
        .then((c) => live && setChecker(c))
        .catch(() => {});
    }, 50);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [active, opts.language]);

  /** Find and mark misspellings. `includeTyping` also checks the word at the caret. */
  const refresh = useCallback((includeTyping = false) => {
    const root = editor.current;
    if (!root) return;
    if (!checker || !optsRef.current.spellcheck || !highlightsSupported) {
      flagged.current = [];
      flaggedByEditor.delete(root);
      paint('spelling-error', flaggedByEditor);
      return;
    }
    const at = caret();
    const typing = !includeTyping && at && typedAt.current && typedAt.current.node === at.node && typedAt.current.offset === at.offset ? at : null;
    const found: { range: Range; word: string }[] = [];
    let block: Element | null = null;
    let before = '';
    for (const node of checkedTextNodes(root)) {
      const b = blockOf(node, root);
      if (b !== block) before = '';
      block = b;
      // A little of the text before, in the same block, tells us whether a word starts a sentence.
      const text = before + node.data;
      for (const t of misspellings(text, checker)) {
        const start = t.start - before.length;
        const end = t.end - before.length;
        if (start < 0) continue;
        if (typing && typing.node === node && start < typing.offset && typing.offset <= end) continue;
        found.push({ range: rangeAt(node, start, end), word: t.word });
      }
      before = text.slice(-8);
    }
    flagged.current = found;
    flaggedByEditor.set(
      root,
      found.map((f) => f.range),
    );
    paint('spelling-error', flaggedByEditor);
  }, [editor, checker]);

  const schedule = useCallback(
    (ms: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => refresh(), ms);
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
  }, [refresh, opts.spellcheck]);

  useEffect(() => onDictionaryChange(() => schedule(0)), [schedule]);

  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showCorrected = useCallback(() => {
    const root = editor.current;
    if (!root) return;
    // Drop corrections the user has since edited away.
    corrections.current = corrections.current.filter((c) => !c.range.collapsed && c.range.toString() === c.corrected);
    const now = Date.now();
    const fresh = corrections.current.filter((c) => now - c.at < MARK_MS);
    correctedByEditor.set(
      root,
      fresh.map((c) => c.range),
    );
    paint('spelling-corrected', correctedByEditor);
    if (fade.current) clearTimeout(fade.current);
    if (fresh.length > 0) fade.current = setTimeout(showCorrected, MARK_MS - (now - Math.max(...fresh.map((c) => c.at))) + 20);
  }, [editor]);

  // Clear this editor's marks when it goes away.
  useEffect(() => {
    const root = editor.current;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (fade.current) clearTimeout(fade.current);
      if (!root) return;
      flaggedByEditor.delete(root);
      correctedByEditor.delete(root);
      paint('spelling-error', flaggedByEditor);
      paint('spelling-corrected', correctedByEditor);
    };
  }, [editor]);

  const openAt = useCallback(
    (node: Node, offset: number, viaKeyboard: boolean): boolean => {
      const c = corrections.current.find((x) => holds(x.range, node, offset) && x.range.toString() === x.corrected);
      if (c) {
        setCard({ kind: 'corrected', range: c.range, correction: c, viaKeyboard });
        return true;
      }
      const f = flagged.current.find((x) => holds(x.range, node, offset));
      if (f && checker) {
        setCard({ kind: 'misspelt', range: f.range, word: f.word, suggestions: suggestionsFor(f.word, checker), viaKeyboard });
        return true;
      }
      return false;
    },
    [checker],
  );

  useEffect(() => {
    const root = editor.current;
    if (!root) return;

    const onBeforeInput = (e: InputEvent) => {
      justCorrected.current = null;
      const o = optsRef.current;
      const fixing = !!checker && o.autocorrect;
      if ((!fixing && !o.autocapitalize) || e.isComposing) return;
      const ends = e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak' || (e.inputType === 'insertText' && e.data !== null && BOUNDARY.test(e.data));
      if (!ends) return;
      const at = caret();
      if (!at || at.node.nodeType !== Node.TEXT_NODE) return;
      const skip = at.node.parentElement?.closest(SKIP);
      if (skip && root.contains(skip)) return;
      const text = (at.node as Text).data;
      const boundary = e.inputType === 'insertText' ? e.data! : '\n';
      const found = finishedWord(text, at.offset, o.autocapitalize ? boundary : '');
      if (!found) return;
      const { word, start, end, afterStop } = found;
      const before = textBefore(root, at.node, start);
      // A word ended by a stop was already checked for typos when the stop was typed.
      let fixed = fixing && !afterStop ? autocorrection(word, checker!, startsSentence(before + word, before.length)) : null;
      const capital = o.autocapitalize && boundary !== '.' ? capitalFor(fixed ?? word, before) : null;
      if (capital) fixed = capital;
      if (!fixed || fixed === word) return;
      e.preventDefault();
      replaceRange(rangeAt(at.node, start, end), fixed);
      // The editor may have split or replaced the text node, so measure from the caret.
      const wordEnd = caret();
      if (!wordEnd || wordEnd.offset < fixed.length) return;
      const range = rangeAt(wordEnd.node, wordEnd.offset - fixed.length, wordEnd.offset);
      // Put the caret back after the stop before typing what was typed.
      if (afterStop) window.getSelection()?.collapse(wordEnd.node, Math.min(wordEnd.offset + (at.offset - end), wordEnd.node.textContent?.length ?? 0));
      if (e.inputType === 'insertText') document.execCommand('insertText', false, e.data!);
      else document.execCommand(e.inputType === 'insertParagraph' ? 'insertParagraph' : 'insertLineBreak');
      const capitalOnly = fixed === capitalised(word);
      const correction: Correction = { range, original: word, corrected: fixed, at: Date.now(), capitalOnly };
      if (!capitalOnly) corrections.current.push(correction);
      const after = caret();
      if (after) justCorrected.current = { correction, node: after.node, offset: after.offset };
      showCorrected();
    };

    const onInput = (e: Event) => {
      const ie = e as InputEvent;
      const at = caret();
      const typing = (ie.inputType === 'insertText' && ie.data !== null && !BOUNDARY.test(ie.data)) || ie.inputType === 'deleteContentBackward' || ie.inputType === 'insertCompositionText';
      typedAt.current = typing ? at : null;
      setCard(null);
      showCorrected();
      // Check straight away when a word is finished; otherwise wait for a pause.
      schedule(typing ? 350 : 30);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Backspace straight after a correction puts back what was typed, and leaves it be.
      const j = justCorrected.current;
      if (e.key === 'Backspace' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && j) {
        const at = caret();
        if (at && at.node === j.node && at.offset === j.offset && j.correction.range.toString() === j.correction.corrected) {
          e.preventDefault();
          undoCorrection(j.correction, at);
          return;
        }
      }
      if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) justCorrected.current = null;
      // Mod+; opens the next misspelling, as in macOS and Word.
      if (matches(e, 'Mod+;', isMac)) {
        e.preventDefault();
        e.stopPropagation();
        openNext();
      }
    };

    const onMouseUp = () => {
      // After the click has placed the caret.
      setTimeout(() => {
        const at = caret();
        if (at && root.contains(at.node)) {
          if (!openAt(at.node, at.offset, false)) setCard(null);
        }
      }, 0);
    };

    const onContextMenu = (e: MouseEvent) => {
      const pos = caretFromPoint(e.clientX, e.clientY);
      if (!pos || !root.contains(pos.node)) return;
      if (openAt(pos.node, pos.offset, false)) {
        e.preventDefault();
        const sel = window.getSelection();
        sel?.collapse(pos.node, pos.offset);
      }
    };

    const onSelection = () => {
      const at = caret();
      if (at && root.contains(at.node) && typedAt.current && (typedAt.current.node !== at.node || typedAt.current.offset !== at.offset)) {
        typedAt.current = null;
        schedule(150);
      }
    };

    const undoCorrection = (c: Correction, at: { node: Node; offset: number }) => {
      const sameNode = c.range.startContainer === at.node;
      const restoreOffset = at.offset + (sameNode ? c.original.length - c.corrected.length : 0);
      replaceRange(c.range, c.original);
      window.getSelection()?.collapse(at.node, Math.min(restoreOffset, at.node.textContent?.length ?? restoreOffset));
      corrections.current = corrections.current.filter((x) => x !== c);
      justCorrected.current = null;
      if (!c.capitalOnly) ignoreWord(c.original);
      showCorrected();
    };

    const openNext = () => {
      typedAt.current = null;
      refresh(true);
      const at = caret();
      const list = flagged.current;
      if (list.length === 0) return;
      const next =
        (at &&
          list.find((f) => {
            const point = document.createRange();
            point.setStart(at.node, at.offset);
            return f.range.compareBoundaryPoints(Range.END_TO_START, point) > 0 || holds(f.range, at.node, at.offset);
          })) ||
        list[0];
      const sel = window.getSelection();
      sel?.collapse(next.range.startContainer, next.range.startOffset);
      next.range.startContainer.parentElement?.scrollIntoView({ block: 'nearest' });
      openAt(next.range.startContainer, next.range.startOffset, true);
    };

    root.addEventListener('beforeinput', onBeforeInput);
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('mouseup', onMouseUp);
    root.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('selectionchange', onSelection);
    return () => {
      root.removeEventListener('beforeinput', onBeforeInput);
      root.removeEventListener('input', onInput);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('mouseup', onMouseUp);
      root.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('selectionchange', onSelection);
    };
  }, [editor, checker, schedule, refresh, openAt, showCorrected]);

  const close = useCallback((refocus: boolean) => {
    setCard(null);
    if (refocus) editor.current?.focus();
  }, [editor]);

  const apply = (r: Range, text: string) => {
    editor.current?.focus();
    replaceRange(r, text);
    setCard(null);
  };

  const view = card && (
    <SuggestionCard
      card={card}
      onClose={close}
      onPick={(s) => apply(card.range, s)}
      onUndo={(c) => {
        editor.current?.focus();
        replaceRange(c.range, c.original);
        corrections.current = corrections.current.filter((x) => x !== c);
        ignoreWord(c.original);
        showCorrected();
        setCard(null);
      }}
      onAdd={(w) => {
        optsRef.current.addWord(w);
        ignoreWord(w);
        close(card.viaKeyboard);
      }}
      onIgnore={(w) => {
        ignoreWord(w);
        close(card.viaKeyboard);
      }}
    />
  );

  // For when the editor's content is replaced from outside (a signature swapped in).
  const recheck = useCallback(() => schedule(0), [schedule]);

  return { card: view, nativeSpellcheck: opts.spellcheck && !highlightsSupported, recheck };
}

/**
 * Capitals for a one-line text field such as the subject: the first word of a
 * sentence, and days and months. Backspace straight after puts the word back.
 * The change is typed in, so onChange and undo work as usual. Returns
 * the field's ref.
 */
export function useFieldCapitals(enabled: boolean): (el: HTMLInputElement | null) => void {
  const [el, setEl] = useState<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!el || !enabled) return;
    let just: { caret: number; start: number; original: string; corrected: string } | null = null;
    const onBeforeInput = (e: InputEvent) => {
      just = null;
      if (e.isComposing || e.inputType !== 'insertText' || !e.data || !BOUNDARY.test(e.data) || e.data === '.') return;
      const at = el.selectionStart;
      if (at === null || at !== el.selectionEnd) return;
      const found = finishedWord(el.value, at, e.data);
      const fixed = found && capitalFor(found.word, el.value.slice(0, found.start));
      if (!found || !fixed) return;
      // Typed into the field, so it joins the undo history and React hears it.
      e.preventDefault();
      el.setSelectionRange(found.start, found.end);
      document.execCommand('insertText', false, fixed);
      el.setSelectionRange(at, at);
      document.execCommand('insertText', false, e.data);
      just = { caret: at + e.data.length, start: found.start, original: found.word, corrected: fixed };
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const j = just;
      if (e.key !== 'Shift') just = null;
      if (e.key !== 'Backspace' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || !j) return;
      if (el.selectionStart !== j.caret || el.selectionEnd !== j.caret || el.value.slice(j.start, j.start + j.corrected.length) !== j.corrected) return;
      e.preventDefault();
      el.setSelectionRange(j.start, j.start + j.corrected.length);
      document.execCommand('insertText', false, j.original);
      el.setSelectionRange(j.caret, j.caret);
    };
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [el, enabled]);
  return setEl;
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

function SuggestionCard({
  card,
  onClose,
  onPick,
  onUndo,
  onAdd,
  onIgnore,
}: {
  card: Card;
  onClose: (refocus: boolean) => void;
  onPick: (s: string) => void;
  onUndo: (c: Correction) => void;
  onAdd: (word: string) => void;
  onIgnore: (word: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const word = card.range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const above = word.bottom + 6 + box.height > window.innerHeight - 8;
    const top = above ? Math.max(8, word.top - box.height - 6) : word.bottom + 6;
    const left = Math.min(Math.max(8, word.left - 6), window.innerWidth - box.width - 8);
    setPos({ left, top, above });
    if (card.viaKeyboard) el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [card]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose(false);
    };
    const away = () => onClose(false);
    window.addEventListener('mousedown', down);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [onClose]);

  useCommand('escape', () => {
    onClose(true);
  });

  // Arrow keys move between the buttons when the card has focus.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    buttons[(i + step + buttons.length) % buttons.length]?.focus();
  };

  const prevent = (e: ReactMouseEvent) => e.preventDefault(); // keep the editor's selection

  return createPortal(
    <div
      ref={ref}
      className={`spell-card${pos?.above ? ' above' : ''}`}
      role="dialog"
      aria-label={card.kind === 'misspelt' ? `Spelling: ${card.word}` : 'Autocorrected'}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onKeyDown={onKeyDown}
      onMouseDown={prevent}
    >
      {card.kind === 'misspelt' ? (
        <>
          <div className="spell-suggestions">
            {card.suggestions.length > 0 ? (
              card.suggestions.map((s, i) => (
                <button key={s} type="button" className={`spell-chip${i === 0 ? ' best' : ''}`} onClick={() => onPick(s)}>
                  {s}
                </button>
              ))
            ) : (
              <span className="spell-none">No suggestions</span>
            )}
          </div>
          <div className="spell-actions">
            <button type="button" className="spell-action" onClick={() => onAdd(card.word)}>
              <BookPlus size={13} />
              Add to dictionary
            </button>
            <button type="button" className="spell-action" onClick={() => onIgnore(card.word)}>
              <EyeOff size={13} />
              Ignore
            </button>
            <span className="spell-hint">{keyLabel('Mod+;')} next</span>
          </div>
        </>
      ) : (
        <div className="spell-corrected">
          <span>
            Corrected from <s>{card.correction.original}</s>
          </span>
          <button type="button" className="spell-action" onClick={() => onUndo(card.correction)}>
            <Undo2 size={13} />
            Undo
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
