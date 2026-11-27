// Web account calendars read from Outlook on the web (docs/WEB_CALENDAR.md).

import type { Account, CalendarEvent } from '../api/types';
import { agoTime, hhmm, sameDay, fullTime } from './dates';

/** After this long without a good refresh the calendar list says so. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/** Plain words for the short error codes the page reports. */
export function webCalendarErrorText(code: string): string {
  if (code === 'signed_out') return 'Signed out of Outlook on the web';
  if (code === 'timeout') return 'Outlook on the web didn’t answer';
  if (code === 'too_many') return 'Too many events to read';
  if (code === 'network') return 'Couldn’t reach Outlook on the web';
  const http = code.match(/^http_(\d+)$/);
  if (code === 'no_token') return 'Outlook on the web hasn’t finished signing in';
  if (code === 'http_401') return 'Outlook on the web refused the sign-in token';
  if (http) return `Outlook on the web returned an error (${http[1]})`;
  return 'Couldn’t read the calendar from Outlook on the web';
}

function since(iso: string, ref: Date): string {
  const d = new Date(iso);
  return sameDay(d, ref) ? hhmm(d) : fullTime(iso, ref);
}

/**
 * The note next to a web calendar in the calendar list: the error, or "Not updated since
 * 10:42" once the last good refresh is over an hour old. Null when all is well.
 */
export function webCalendarNote(a: Account, ref: Date): string | null {
  if (a.kind !== 'web' || !a.webCalendar) return null;
  if (a.webCalendarError) return webCalendarErrorText(a.webCalendarError);
  if (!a.webCalendarSyncedAt) return 'Not read yet';
  if (ref.getTime() - new Date(a.webCalendarSyncedAt).getTime() > STALE_AFTER_MS) return `Not updated since ${since(a.webCalendarSyncedAt, ref)}`;
  return null;
}

/** The status line in account settings: "Updated 4 min ago", or the error. */
export function webCalendarStatus(a: Account, ref: Date): string {
  const updated = a.webCalendarSyncedAt ? `Updated ${agoTime(a.webCalendarSyncedAt, ref)}` : 'Not read yet';
  if (a.webCalendarError) return `${webCalendarErrorText(a.webCalendarError)} · ${a.webCalendarSyncedAt ? updated.replace(/^Updated/, 'last updated') : 'nothing read yet'}`;
  return updated;
}

/** The source line in the event panel for a web event. */
export function webEventSource(a: Account | undefined, ref: Date): string {
  const at = a?.webCalendarSyncedAt;
  return at ? `From Outlook on the web · updated ${agoTime(at, ref)}` : 'From Outlook on the web';
}

/** Which actions the event panel offers. Read-only events offer none. */
export function eventActions(e: CalendarEvent): { respond: boolean; edit: boolean; delete: boolean } {
  if (e.readOnly) return { respond: false, edit: false, delete: false };
  const organizer = e.myResponse === 'organizer';
  return { respond: !organizer, edit: organizer, delete: organizer };
}

/**
 * Not firmly in your diary: you said Tentative, or it's an invitation you haven't answered.
 * Drawn dashed and washed out, like Outlook. Read-only (web) events never count as unanswered.
 */
export function isPending(e: CalendarEvent): boolean {
  return e.myResponse === 'tentative' || (e.myResponse === 'none' && eventActions(e).respond);
}
