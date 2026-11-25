import { describe, expect, it } from 'vitest';
import type { Account } from '../api/types';
import { graphCalendarNote } from './calendarNote';

const graph = (patch: Partial<Account> = {}): Account => ({
  id: 'acc-g',
  email: 'me@coda.example',
  displayName: 'Coda',
  kind: 'graph',
  color: '#0969DA',
  unread: 0,
  notifications: true,
  offlineMonths: 6,
  syncState: 'syncing',
  webCalendar: false,
  ...patch,
});

describe('graphCalendarNote', () => {
  it('says nothing once calendars are stored', () => {
    expect(graphCalendarNote(graph(), 1)).toBeNull();
  });

  it('says nothing for web accounts', () => {
    expect(graphCalendarNote(graph({ kind: 'web' }), 0)).toBeNull();
  });

  it('explains the wait during the first sync', () => {
    expect(graphCalendarNote(graph({ syncState: 'syncing' }), 0)).toBe('Calendars load after mail finishes syncing');
    expect(graphCalendarNote(graph({ syncState: 'idle' }), 0)).toBe('Calendars load after mail finishes syncing');
  });

  it('names what is blocking it', () => {
    expect(graphCalendarNote(graph({ syncState: 'error', syncError: 'boom' }), 0)).toBe('Sync failed before calendars loaded');
    expect(graphCalendarNote(graph({ syncState: 'needsAuth' }), 0)).toBe('Sign in again to load calendars');
    expect(graphCalendarNote(graph({ syncState: 'offline' }), 0)).toBe('Offline · calendars load once connected');
  });
});
