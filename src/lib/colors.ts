// Account colours and the tints used for calendar events.

export const PALETTE = ['#1F883D', '#8250DF', '#D4600F', '#0B5CC4', '#BF3989', '#1A7F8E'];
export const WEB_ONLY = '#6E7781';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: number[]): string {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Mix colour with a base: amount 0 = base, 1 = colour. */
export function mix(color: string, amount: number, base = '#FFFFFF'): string {
  const a = hexToRgb(color);
  const b = hexToRgb(base);
  return toHex(a.map((v, i) => b[i] + (v - b[i]) * amount));
}

export function eventFill(color: string, dark: boolean): string {
  return dark ? mix(color, 0.4, '#16191D') : mix(color, 0.32);
}

export function eventBorder(color: string, dark: boolean): string {
  return dark ? mix(color, 0.62, '#16191D') : mix(color, 0.55);
}

export function eventSelectedFill(color: string, dark: boolean): string {
  return dark ? mix(color, 0.55, '#16191D') : mix(color, 0.48);
}
