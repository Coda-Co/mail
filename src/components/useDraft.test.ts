// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draft } from '../api/types';

// An event bus and a getDraft whose answer the test hands over when it chooses.
const handlers = new Set<(p: { draftId: string }) => void>();
let pendingGet: ((d: Draft) => void) | null = null;
vi.mock('../api', () => ({
  EVENTS: { draftChanged: 'draft://changed' },
  onEvent: (_name: string, h: (p: { draftId: string }) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  api: {
    getDraft: () => new Promise<Draft>((resolve) => (pendingGet = resolve)),
    updateDraft: async (d: Draft) => d,
  },
}));

const { useDraft } = await import('./Compose');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = { id: 'acc:1', bodyHtml: '<p>Hello</p>', updatedAt: 't1' } as Draft;

function mount() {
  let hook!: ReturnType<typeof useDraft>;
  function Probe() {
    hook = useDraft(initial);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  return { get: () => hook, root };
}

afterEach(() => {
  handlers.clear();
  pendingGet = null;
});

describe('useDraft', () => {
  it('ignores a fetched copy that is older than what the user typed meanwhile', async () => {
    const { get, root } = mount();
    // Our autosave's echo arrives while nothing is unsaved, so a fetch starts...
    act(() => handlers.forEach((h) => h({ draftId: initial.id })));
    expect(pendingGet).not.toBeNull();
    // ...the user keeps typing before it returns...
    act(() => get().update({ bodyHtml: '<p>Hello there</p>' }));
    // ...and the stale copy comes back.
    await act(async () => pendingGet!({ ...initial, bodyHtml: '<p>Hello</p>' }));
    expect(get().draft.bodyHtml).toBe('<p>Hello there</p>');
    act(() => root.unmount());
  });

  it('still takes edits made in another window', async () => {
    const { get, root } = mount();
    act(() => handlers.forEach((h) => h({ draftId: initial.id })));
    await act(async () => pendingGet!({ ...initial, bodyHtml: '<p>From the pop-out</p>', updatedAt: 't2' }));
    expect(get().draft.bodyHtml).toBe('<p>From the pop-out</p>');
    act(() => root.unmount());
  });
});
