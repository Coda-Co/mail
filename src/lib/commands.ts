import { useEffect, useRef } from 'react';
import type { ShortcutId } from './shortcuts';

// Views register handlers for shortcuts while mounted; the most recently
// mounted handler for an id wins (e.g. a modal over the mail view).
type Handler = () => boolean | void;
const stacks = new Map<ShortcutId, Handler[]>();

export function runCommand(id: ShortcutId): boolean {
  const stack = stacks.get(id);
  if (!stack || stack.length === 0) return false;
  for (let i = stack.length - 1; i >= 0; i--) {
    // A handler returning false passes the shortcut to the one below it.
    if (stack[i]() !== false) return true;
  }
  return false;
}

export function useCommand(id: ShortcutId, handler: Handler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const fn: Handler = () => ref.current();
    const stack = stacks.get(id) ?? [];
    stack.push(fn);
    stacks.set(id, stack);
    return () => {
      const s = stacks.get(id);
      if (s) s.splice(s.indexOf(fn), 1);
    };
  }, [id, enabled]);
}
