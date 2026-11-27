import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { setOwnWords } from '../lib/dictionary';
import { useApp } from '../state/app';
import { useSpelling } from './Spelling';

export interface RichEditorHandle {
  focus: () => void;
  element: () => HTMLDivElement | null;
}

interface Props {
  html: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  label: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** Spell check and autocorrect, as set in Settings. */
  spelling?: boolean;
}

function isEmpty(el: HTMLElement): boolean {
  return (el.textContent ?? '').trim() === '' && !el.querySelector('img');
}

/**
 * A small contentEditable editor. Formatting comes from the browser's own
 * editing commands (Ctrl/Cmd+B, I) plus whatever toolbar the parent adds.
 */
export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor({ html, onChange, placeholder, className, autoFocus, label, onKeyDown, spelling }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const [empty, setEmpty] = useState(true);
  const { settings, updateSettings } = useApp();

  useEffect(() => setOwnWords(settings.dictionary), [settings.dictionary]);
  const addWord = useCallback(
    async (word: string) => {
      // Start from the saved list, which another window may have added to.
      const saved = await api.getSettings().catch(() => settings);
      await updateSettings({ dictionary: [...saved.dictionary, word.toLowerCase()] }).catch(() => {});
    },
    [settings, updateSettings],
  );
  const { card, nativeSpellcheck, recheck } = useSpelling(el, {
    spellcheck: !!spelling && settings.spellcheck,
    autocorrect: !!spelling && settings.autocorrect,
    autocapitalize: !!spelling && settings.autocapitalize,
    language: settings.spellingLanguage,
    addWord,
  });

  useImperativeHandle(ref, () => ({
    focus: () => {
      const node = el.current;
      if (!node) return;
      node.focus();
      // Caret at the start, above any signature.
      const range = document.createRange();
      const first = node.firstChild;
      if (first) {
        range.setStart(first.nodeType === Node.TEXT_NODE ? first : first, 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    },
    element: () => el.current,
  }));

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    if (html !== lastEmitted.current && node.innerHTML !== html) {
      node.innerHTML = html;
      lastEmitted.current = html;
      recheck();
    }
    setEmpty(isEmpty(node));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  useLayoutEffect(() => {
    if (autoFocus) {
      const node = el.current;
      node?.focus();
    }
  }, [autoFocus]);

  return (
    <>
      <div
        ref={el}
        // Our own spell check draws its own marks; the web view's would double them up.
        spellCheck={spelling ? nativeSpellcheck : undefined}
        autoCorrect={spelling && settings.autocorrect ? 'off' : undefined}
        autoCapitalize={spelling && settings.autocapitalize ? 'off' : undefined}
        className={`rich-editor ${className ?? ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        data-placeholder={placeholder}
        data-empty={empty}
        onInput={(e) => {
          const node = e.currentTarget;
          const value = node.innerHTML;
          lastEmitted.current = value;
          setEmpty(isEmpty(node));
          onChange(value);
        }}
        onKeyDown={onKeyDown}
      />
      {card}
    </>
  );
});

/** Run a formatting command on the current selection. */
export function format(command: string, value?: string): void {
  document.execCommand(command, false, value);
}
