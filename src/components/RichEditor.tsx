import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

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
}

function isEmpty(el: HTMLElement): boolean {
  return (el.textContent ?? '').trim() === '' && !el.querySelector('img');
}

/**
 * A small contentEditable editor. Formatting comes from the browser's own
 * editing commands (Ctrl/Cmd+B, I) plus whatever toolbar the parent adds.
 */
export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor({ html, onChange, placeholder, className, autoFocus, label, onKeyDown }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const [empty, setEmpty] = useState(true);

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
    }
    setEmpty(isEmpty(node));
  }, [html]);

  useLayoutEffect(() => {
    if (autoFocus) {
      const node = el.current;
      node?.focus();
    }
  }, [autoFocus]);

  return (
    <div
      ref={el}
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
  );
});

/** Run a formatting command on the current selection. */
export function format(command: string, value?: string): void {
  document.execCommand(command, false, value);
}
