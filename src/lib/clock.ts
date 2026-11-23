// "Now" for the interface. The demo backend pins it to the mockups' moment
// (Mon 23 Nov 2026, 09:50 local) so screens match the designs; ?now=<ISO> overrides.
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function pinned(): Date | null {
  if (isTauri) return null;
  try {
    const param = new URLSearchParams(window.location.search).get('now');
    if (param) {
      const d = new Date(param);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch {
    /* not in a browser */
  }
  return new Date(2026, 10, 23, 9, 50);
}

const fixed = typeof window === 'undefined' ? new Date(2026, 10, 23, 9, 50) : pinned();
const startedAt = Date.now();

/** Current time. In demo mode the pinned moment advances with real time. */
export function now(): Date {
  if (!fixed) return new Date();
  return new Date(fixed.getTime() + (Date.now() - startedAt));
}

export function demoNow(): Date {
  return new Date(fixed ? fixed.getTime() : Date.now());
}
