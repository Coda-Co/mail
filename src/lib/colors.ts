// Account colours and the tints used for calendar events.

export const PALETTE = ['#1F883D', '#8250DF', '#D4600F', '#0B5CC4', '#BF3989', '#1A7F8E'];
export const WEB_ONLY = '#6E7781';

const FILL: Record<string, string> = { '#1F883D': '#EAF6EE', '#8250DF': '#F1ECFC', '#D4600F': '#FCEFE5' };
const BORDER: Record<string, string> = { '#1F883D': '#B7DFC3', '#8250DF': '#D3C4F5', '#D4600F': '#F2CBAE' };

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
  if (dark) return mix(color, 0.22, '#16191D');
  return FILL[color.toUpperCase()] ?? mix(color, 0.1);
}

export function eventBorder(color: string, dark: boolean): string {
  if (dark) return mix(color, 0.5, '#16191D');
  return BORDER[color.toUpperCase()] ?? mix(color, 0.35);
}

export function eventSelectedFill(color: string, dark: boolean): string {
  return dark ? mix(color, 0.36, '#16191D') : mix(color, 0.22);
}
