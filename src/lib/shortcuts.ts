// Keyboard shortcuts, identical on Windows and macOS: "Mod" is Ctrl on
// Windows/Linux and Cmd on macOS.

export type ShortcutId =
  | 'newMessage'
  | 'reply'
  | 'replyAll'
  | 'ctrlF'
  | 'archive'
  | 'delete'
  | 'markUnread'
  | 'undo'
  | 'send'
  | 'search'
  | 'escape'
  | 'goMail'
  | 'goCalendar'
  | 'goPeople'
  | 'next'
  | 'previous';

export interface Shortcut {
  id: ShortcutId;
  combo: string;
  /** Single-key shortcuts don't fire while typing. */
  allowInInput: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'newMessage', combo: 'Mod+N', allowInInput: false },
  { id: 'replyAll', combo: 'Mod+Shift+R', allowInInput: false },
  { id: 'reply', combo: 'Mod+R', allowInInput: false },
  { id: 'ctrlF', combo: 'Mod+F', allowInInput: false },
  { id: 'archive', combo: 'E', allowInInput: false },
  { id: 'delete', combo: 'Delete', allowInInput: false },
  { id: 'markUnread', combo: 'Mod+U', allowInInput: false },
  // Not while typing, so text fields keep their own undo.
  { id: 'undo', combo: 'Mod+Z', allowInInput: false },
  { id: 'send', combo: 'Mod+Enter', allowInInput: true },
  { id: 'search', combo: 'Mod+E', allowInInput: true },
  { id: 'escape', combo: 'Escape', allowInInput: true },
  { id: 'goMail', combo: 'Mod+1', allowInInput: true },
  { id: 'goCalendar', combo: 'Mod+2', allowInInput: true },
  { id: 'goPeople', combo: 'Mod+3', allowInInput: true },
  { id: 'next', combo: 'J', allowInInput: false },
  { id: 'next', combo: 'ArrowDown', allowInInput: false },
  { id: 'previous', combo: 'K', allowInInput: false },
  { id: 'previous', combo: 'ArrowUp', allowInInput: false },
];

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Does this key event match a combo like "Mod+Shift+R"? */
export function matches(e: KeyLike, combo: string, mac: boolean): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const wantMod = parts.includes('Mod');
  const wantShift = parts.includes('Shift');
  const wantAlt = parts.includes('Alt');
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (mod !== wantMod || otherMod) return false;
  if (e.altKey !== wantAlt) return false;
  // Shift is only checked for letter shortcuts and explicit Shift combos.
  if (wantShift !== e.shiftKey && (wantShift || key.length === 1)) return false;
  if (key.length === 1) return e.key.toLowerCase() === key.toLowerCase();
  if (key === 'Delete') return e.key === 'Delete' || (mac && e.key === 'Backspace' && !wantMod);
  return e.key === key;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

/**
 * Keys the webview would otherwise act on itself (reload, hard reload), which
 * throws away app state. Always swallowed, even when no handler is ready yet
 * or focus is in a text field.
 */
export function isBrowserReserved(e: KeyLike, mac: boolean): boolean {
  if (e.key === 'F5') return true;
  return matches(e, 'Mod+R', mac) || matches(e, 'Mod+Shift+R', mac);
}

/** First shortcut matching the event, honouring the typing rule. */
export function resolveShortcut(e: KeyLike, typing: boolean, mac: boolean): ShortcutId | null {
  for (const s of SHORTCUTS) {
    if (typing && !s.allowInInput) continue;
    if (matches(e, s.combo, mac)) return s.id;
  }
  return null;
}
