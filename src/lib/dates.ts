import { now } from './clock';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const monthName = (m: number) => MONTHS[m];
export const monthShort = (m: number) => MONTHS[m].slice(0, 3);
export const dayName = (d: number) => DAYS[d];
export const dayShort = (d: number) => DAYS[d].slice(0, 3);

export const pad = (n: number) => String(n).padStart(2, '0');

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Monday of the week containing d. */
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7;
  return addDays(s, -dow);
}

export function hhmm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Message list time: 09:42, Yesterday, Mon, 12 Nov, 3 Mar 2025. */
export function listTime(iso: string, ref: Date = now()): string {
  const d = new Date(iso);
  const today = startOfDay(ref);
  const day = startOfDay(d);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diffDays <= 0) return hhmm(d);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return dayShort(d.getDay());
  if (d.getFullYear() === ref.getFullYear()) return `${d.getDate()} ${monthShort(d.getMonth())}`;
  return `${d.getDate()} ${monthShort(d.getMonth())} ${d.getFullYear()}`;
}

/** Reading pane time: 09:42 today, otherwise "Thu 12 Nov, 09:42". */
export function fullTime(iso: string, ref: Date = now()): string {
  const d = new Date(iso);
  if (sameDay(d, ref)) return hhmm(d);
  const year = d.getFullYear() === ref.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${dayShort(d.getDay())} ${d.getDate()} ${monthShort(d.getMonth())}${year}, ${hhmm(d)}`;
}

/** "Thursday 26 November" */
export function longDate(d: Date): string {
  return `${dayName(d.getDay())} ${d.getDate()} ${monthName(d.getMonth())}`;
}

/** "Mon 23 Nov" */
export function shortDate(d: Date): string {
  return `${dayShort(d.getDay())} ${d.getDate()} ${monthShort(d.getMonth())}`;
}

/** "23 – 27 November", "30 November – 4 December", "28 December 2026 – 1 January 2027" */
export function rangeTitle(start: Date, end: Date): string {
  if (sameDay(start, end)) return `${longDate(start)}`;
  if (start.getFullYear() !== end.getFullYear())
    return `${start.getDate()} ${monthName(start.getMonth())} ${start.getFullYear()} – ${end.getDate()} ${monthName(end.getMonth())} ${end.getFullYear()}`;
  if (start.getMonth() !== end.getMonth())
    return `${start.getDate()} ${monthName(start.getMonth())} – ${end.getDate()} ${monthName(end.getMonth())}`;
  return `${start.getDate()} – ${end.getDate()} ${monthName(end.getMonth())}`;
}

/** How long ago something happened: "just now", "4 min ago", "at 09:42", "yesterday at 09:42". */
export function agoTime(iso: string, ref: Date = now()): string {
  const d = new Date(iso);
  const mins = Math.floor((ref.getTime() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (sameDay(d, ref)) return `at ${hhmm(d)}`;
  if (sameDay(d, addDays(ref, -1))) return `yesterday at ${hhmm(d)}`;
  return `on ${fullTime(iso, ref)}`;
}
