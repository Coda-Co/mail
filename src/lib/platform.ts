export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Label for the primary modifier: "Ctrl" on Windows/Linux, "Cmd" on macOS. */
export const modLabel = isMac ? 'Cmd' : 'Ctrl';

/** "Ctrl+E" / "Cmd+E" */
export function keyLabel(combo: string): string {
  return combo.replace(/Mod/g, modLabel);
}
