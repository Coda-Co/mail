import { describe, expect, it } from 'vitest';
import type { Account, CalendarEvent } from '../api/types';
import { eventActions, webCalendarErrorText, webCalendarNote, webCalendarStatus } from './webCalendar';

const ref = new Date(2026, 10, 23, 12, 0);
const minsAgo = (m: number) => new Date(ref.getTime() - m * 60000).toISOString();
const web = (patch: Partial<Account> = {}): Account => ({
  id: 'acc-w',
  email: 'me@client.example',
  displayName: 'Client',
  kind: 'web',
  color: '#6E7781',
  unread: null,
  notifications: true,
  offlineMonths: 0,
  syncState: 'idle',
  webCalendar: true,
  webCalendarSyncedAt: minsAgo(4),
  ...patch,
});
const event = (patch: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e',
  accountId: 'a',
  calendarId: 'c',
  subject: 'x',
  start: ref.toISOString(),
  end: ref.toISOString(),
  isAllDay: false,
  location: '',
  bodyHtml: '',
  organizer: { name: '', email: '' },
  attendees: [],
  myResponse: 'none',
  isOnlineMeeting: false,
  isCancelled: false,
  color: '#000',
  readOnly: false,
  ...patch,
});

describe('web calendar status', () => {
  it('is quiet while fresh', () => expect(webCalendarNote(web(), ref)).toBeNull());
  it('says when it is over an hour old', () => {
    const at = new Date(2026, 10, 23, 10, 42).toISOString();
    expect(webCalendarNote(web({ webCalendarSyncedAt: at }), ref)).toBe('Not updated since 10:42');
  });
  it('shows the error and keeps the last update time', () => {
    const a = web({ webCalendarError: 'signed_out' });
    expect(webCalendarNote(a, ref)).toBe('Signed out of Outlook on the web');
    expect(webCalendarStatus(a, ref)).toBe('Signed out of Outlook on the web · last updated 4 min ago');
  });
  it('says how long ago it updated', () => expect(webCalendarStatus(web(), ref)).toBe('Updated 4 min ago'));
  it('has nothing to say while off or for Graph accounts', () => {
    expect(webCalendarNote(web({ webCalendar: false }), ref)).toBeNull();
    expect(webCalendarNote(web({ kind: 'graph' }), ref)).toBeNull();
  });
  it('words error codes', () => {
    expect(webCalendarErrorText('http_503')).toBe('Outlook on the web returned an error (503)');
    expect(webCalendarErrorText('unsupported')).toBe('Couldn’t read the calendar from Outlook on the web');
  });
});

describe('event panel actions', () => {
  it('offers nothing for read-only events', () => {
    expect(eventActions(event({ readOnly: true, myResponse: 'none' }))).toEqual({ respond: false, edit: false, delete: false });
    expect(eventActions(event({ readOnly: true, myResponse: 'organizer' }))).toEqual({ respond: false, edit: false, delete: false });
  });
  it('lets organisers edit and others respond', () => {
    expect(eventActions(event({ myResponse: 'organizer' }))).toEqual({ respond: false, edit: true, delete: true });
    expect(eventActions(event({ myResponse: 'accepted' }))).toEqual({ respond: true, edit: false, delete: false });
  });
});
