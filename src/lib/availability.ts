// Checks the times an email proposes (read by "Find times") against the user's own calendar.
// Done here, not by the AI: the calendar never leaves the device, and overlap is arithmetic.

import type { CalendarEvent, ProposedSlot } from '../api/types';
import { isPending } from './webCalendar';

/**
 * free: nothing in the way. partly: a window with something in it, but the meeting still fits.
 * tentative: only fits over events not yet accepted. busy: doesn't fit.
 */
export type SlotStatus = 'free' | 'partly' | 'tentative' | 'busy';

export interface SlotCheck {
  slot: ProposedSlot;
  status: SlotStatus;
  /** Where the meeting would go: the earliest place it fits (over tentative events if it must). */
  fit?: { start: Date; end: Date };
  /** Timed events overlapping the window, earliest first. */
  overlaps: CalendarEvent[];
  /** All-day events on the day (leave, travel, holidays): shown, never counted as busy. */
  allDay: CalendarEvent[];
  /** The meeting would sit outside working hours. */
  outsideHours: boolean;
}

const MIN = 60_000;
/** Starts tried inside a window, in minutes. */
const STEP = 5;

const ms = (iso: string) => new Date(iso).getTime();

/** Events that take the time: not cancelled, not declined, not all day. */
function counts(e: CalendarEvent): boolean {
  return !e.isCancelled && e.myResponse !== 'declined' && !e.isAllDay;
}

function overlapsSpan(e: CalendarEvent, from: number, to: number): boolean {
  return ms(e.start) < to && ms(e.end) > from;
}

/** Earliest start in [from, latest] where `len` clears every event in `blocking`. */
function earliestFit(from: number, latest: number, len: number, blocking: CalendarEvent[]): number | null {
  for (let t = from; t <= latest; t += STEP * MIN) {
    if (!blocking.some((e) => overlapsSpan(e, t, t + len))) return t;
  }
  return null;
}

/** Minutes after local midnight. */
function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function checkSlot(slot: ProposedSlot, events: CalendarEvent[], workStart: number, workEnd: number): SlotCheck {
  const from = ms(slot.windowStart);
  const to = ms(slot.windowEnd);
  const len = Math.max(1, Math.min(slot.minutes, (to - from) / MIN)) * MIN;
  const latest = to - len;
  const inWindow = events.filter((e) => counts(e) && overlapsSpan(e, from, to)).sort((a, b) => ms(a.start) - ms(b.start));
  const firm = inWindow.filter((e) => !isPending(e));

  const clear = earliestFit(from, latest, len, inWindow);
  const overFirmOnly = clear === null ? earliestFit(from, latest, len, firm) : null;
  const start = clear ?? overFirmOnly;
  const status: SlotStatus = clear !== null ? (inWindow.length === 0 ? 'free' : 'partly') : overFirmOnly !== null ? 'tentative' : 'busy';
  // A window with nothing in it books from its start; exact slots are themselves.
  const fit = start !== null ? { start: new Date(start), end: new Date(start + len) } : undefined;

  const dayStart = new Date(from);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const allDay = events.filter((e) => e.isAllDay && !e.isCancelled && e.myResponse !== 'declined' && overlapsSpan(e, dayStart.getTime(), dayEnd.getTime()));

  const span = fit ?? { start: new Date(from), end: new Date(to) };
  const endMinute = minuteOfDay(span.end) || 24 * 60;
  const outsideHours = span.start.toDateString() !== new Date(span.end.getTime() - 1).toDateString() || minuteOfDay(span.start) < workStart || endMinute > workEnd;

  return { slot, status, fit, overlaps: inWindow, allDay, outsideHours };
}

/** The range of days the slots cover, for one calendar fetch: [start of first day, end of last day). */
export function slotsRange(slots: ProposedSlot[]): { start: string; end: string } | null {
  if (slots.length === 0) return null;
  const first = new Date(Math.min(...slots.map((s) => ms(s.windowStart))));
  const last = new Date(Math.max(...slots.map((s) => ms(s.windowEnd))));
  first.setHours(0, 0, 0, 0);
  last.setHours(24, 0, 0, 0);
  return { start: first.toISOString(), end: last.toISOString() };
}
