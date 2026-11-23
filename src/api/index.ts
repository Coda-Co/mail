import type { MailApi } from './types';
import { tauriApi } from './tauri';
import { demoApi } from './demo';
import { on } from './emitter';

export * from './types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const api: MailApi = isTauri ? tauriApi : demoApi;

/** Subscribe to a core event. Returns an unsubscribe function. */
export function onEvent<T = unknown>(name: string, handler: (payload: T) => void): () => void {
  if (!isTauri) return on(name, handler as (p: unknown) => void);
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  import('@tauri-apps/api/event').then(({ listen }) =>
    listen<T>(name, (e) => handler(e.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }),
  );
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
