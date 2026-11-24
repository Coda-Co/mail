import { describe, expect, it } from 'vitest';
import { matches, resolveShortcut } from './shortcuts';

const key = (k: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('shortcut matching', () => {
  it('uses Ctrl on Windows and Cmd on Mac for Mod', () => {
    expect(matches(key('e', { ctrl: true }), 'Mod+E', false)).toBe(true);
    expect(matches(key('e', { meta: true }), 'Mod+E', false)).toBe(false);
    expect(matches(key('e', { meta: true }), 'Mod+E', true)).toBe(true);
    expect(matches(key('e', { ctrl: true }), 'Mod+E', true)).toBe(false);
  });

  it('distinguishes reply from reply all', () => {
    expect(resolveShortcut(key('r', { ctrl: true }), false, false)).toBe('reply');
    expect(resolveShortcut(key('R', { ctrl: true, shift: true }), false, false)).toBe('replyAll');
    expect(resolveShortcut(key('R', { meta: true, shift: true }), false, true)).toBe('replyAll');
  });

  it('ignores single-key shortcuts while typing', () => {
    expect(resolveShortcut(key('e'), false, false)).toBe('archive');
    expect(resolveShortcut(key('e'), true, false)).toBe(null);
    expect(resolveShortcut(key('Delete'), true, false)).toBe(null);
  });

  it('allows send, search, escape and view switching while typing', () => {
    expect(resolveShortcut(key('Enter', { ctrl: true }), true, false)).toBe('send');
    expect(resolveShortcut(key('e', { ctrl: true }), true, false)).toBe('search');
    expect(resolveShortcut(key('Escape'), true, false)).toBe('escape');
    expect(resolveShortcut(key('2', { meta: true }), true, true)).toBe('goCalendar');
  });

  it('does not treat Shift+E as archive', () => {
    expect(resolveShortcut(key('E', { shift: true }), false, false)).toBe(null);
  });

  it('maps j/k and arrows to list movement', () => {
    expect(resolveShortcut(key('j'), false, false)).toBe('next');
    expect(resolveShortcut(key('ArrowUp'), false, false)).toBe('previous');
  });
});
