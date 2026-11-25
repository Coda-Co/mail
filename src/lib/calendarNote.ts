// Why a Graph account has no calendars to show yet.

import type { Account } from '../api/types';

/**
 * The note under a Graph account in the calendar list while it has no calendars stored.
 * Calendars are read at the end of a full sync, after mail, so a new account (or one whose
 * sync keeps failing) has none for a while. Null once there is something to show.
 */
export function graphCalendarNote(a: Account, calendarCount: number): string | null {
  if (a.kind !== 'graph' || calendarCount > 0) return null;
  switch (a.syncState) {
    case 'needsAuth':
      return 'Sign in again to load calendars';
    case 'error':
      return 'Sync failed before calendars loaded';
    case 'offline':
      return 'Offline · calendars load once connected';
    default:
      return 'Calendars load after mail finishes syncing';
  }
}
