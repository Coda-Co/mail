import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/** The pane widths a person can drag, as CSS variables on the root element. */
export type PaneVar = '--sidebar-w' | '--list-w' | '--agenda-w';

const LIMITS: Record<PaneVar, { min: number; max: number }> = {
  '--sidebar-w': { min: 208, max: 380 },
  '--list-w': { min: 260, max: 720 },
  '--agenda-w': { min: 220, max: 440 },
};

const storageKey = (v: PaneVar) => `mail.paneWidth.${v}`;

function clamp(v: PaneVar, px: number) {
  const { min, max } = LIMITS[v];
  return Math.round(Math.max(min, Math.min(max, px)));
}

function apply(v: PaneVar, px: number | null) {
  const root = document.documentElement.style;
  if (px === null) root.removeProperty(v);
  else root.setProperty(v, `${px}px`);
  try {
    if (px === null) localStorage.removeItem(storageKey(v));
    else localStorage.setItem(storageKey(v), String(px));
  } catch {
    // Storage can be unavailable; the width still applies for this session.
  }
}

/** Puts back the widths saved from earlier sessions. Call once at startup. */
export function restorePaneWidths() {
  for (const v of Object.keys(LIMITS) as PaneVar[]) {
    try {
      const saved = Number(localStorage.getItem(storageKey(v)));
      if (saved > 0) document.documentElement.style.setProperty(v, `${clamp(v, saved)}px`);
    } catch {
      return;
    }
  }
}

type Props = {
  /** The CSS variable holding the pane's width. */
  variable: PaneVar;
  /** Which side of the handle the resized pane sits on. */
  pane: 'before' | 'after';
  label: string;
  className?: string;
};

/**
 * A vertical drag handle between two panes. Dragging sets the width of the
 * pane on one side; arrow keys nudge it, and a double-click resets it.
 */
export function Resizer({ variable, pane, label, className }: Props) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const target = (handle: HTMLElement) => (pane === 'before' ? handle.previousElementSibling : handle.nextElementSibling) as HTMLElement | null;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = target(e.currentTarget);
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startW: el.getBoundingClientRect().width };
    document.documentElement.classList.add('resizing');
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    apply(variable, clamp(variable, drag.current.startW + (pane === 'before' ? dx : -dx)));
  };

  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.documentElement.classList.remove('resizing');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const el = target(e.currentTarget);
    if (!el) return;
    e.preventDefault();
    const step = (e.shiftKey ? 64 : 16) * (e.key === 'ArrowRight' ? 1 : -1) * (pane === 'before' ? 1 : -1);
    apply(variable, clamp(variable, el.getBoundingClientRect().width + step));
  };

  return (
    <div
      className={`resizer${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => apply(variable, null)}
      onKeyDown={onKeyDown}
    />
  );
}
