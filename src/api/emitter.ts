// In-process event bus used by the demo backend (and as a local fallback).
type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();

export function emit(name: string, payload: unknown): void {
  handlers.get(name)?.forEach((h) => {
    try {
      h(payload);
    } catch (err) {
      console.error(err);
    }
  });
}

export function on(name: string, handler: Handler): () => void {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}
