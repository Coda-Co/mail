import { describe, expect, it } from 'vitest';
import type { CalendarEvent, ProposedSlot } from '../api/types';
import { checkSlot, slotsRange } from './availability';

// Local times on Wed 16 Dec 2026, so working-hours checks read the same in any zone.
const at = (h: number, m = 0) => new Date(2026, 11, 16, h, m).toISOString();

function slot(from: [number, number], to: [number, number], minutes?: number, kind: ProposedSlot['kind'] = 'exact'): ProposedSlot {
  const windowStart = at(...from);
  const windowEnd = at(...to);
  return {
    kind,
    windowStart,
    windowEnd,
    minutes: minutes ?? (new Date(windowEnd).getTime() - new Date(windowStart).getTime()) / 60000,
    timeZone: 'Europe/London',
    quote: '',
    approximate: false,
    warnings: [],
  };
}

function event(from: [number, number], to: [number, number], opts: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: `e-${from.join(':')}`,
    accountId: 'a',
    calendarId: 'c',
    subject: 'Busy',
    start: at(...from),
    end: at(...to),
    isAllDay: false,
    location: '',
    bodyHtml: '',
    organizer: { name: '', email: '' },
    attendees: [],
    myResponse: 'organizer',
    isOnlineMeeting: false,
    isCancelled: false,
    color: '#000',
    readOnly: false,
    ...opts,
  };
}

const WORK = [9 * 60, 18 * 60] as const;

describe('checkSlot', () => {
  it('free when nothing overlaps; touching events don’t count', () => {
    const c = checkSlot(slot([11, 30], [12, 30]), [event([10, 30], [11, 30]), event([12, 30], [13, 0])], ...WORK);
    expect(c.status).toBe('free');
    expect(c.fit?.start.toISOString()).toBe(at(11, 30));
    expect(c.overlaps).toEqual([]);
  });

  it('busy when an accepted event overlaps an exact slot', () => {
    const c = checkSlot(slot([11, 0], [12, 0]), [event([11, 45], [12, 15], { subject: 'Steerco', myResponse: 'accepted' })], ...WORK);
    expect(c.status).toBe('busy');
    expect(c.fit).toBeUndefined();
    expect(c.overlaps.map((e) => e.subject)).toEqual(['Steerco']);
  });

  it('tentative when only unanswered or tentative events are in the way', () => {
    const events = [event([11, 0], [12, 0], { myResponse: 'none' }), event([11, 30], [12, 0], { myResponse: 'tentative' })];
    expect(checkSlot(slot([11, 0], [12, 0]), events, ...WORK).status).toBe('tentative');
  });

  it('ignores declined and cancelled events', () => {
    const events = [event([11, 0], [12, 0], { myResponse: 'declined' }), event([11, 0], [12, 0], { isCancelled: true })];
    expect(checkSlot(slot([11, 0], [12, 0]), events, ...WORK).status).toBe('free');
  });

  it('finds where a short meeting fits in a longer window', () => {
    // Free 10:00–12:00 for a 30 minute call, with 10:00–10:45 taken.
    const c = checkSlot(slot([10, 0], [12, 0], 30, 'window'), [event([10, 0], [10, 45])], ...WORK);
    expect(c.status).toBe('partly');
    expect([c.fit?.start.toISOString(), c.fit?.end.toISOString()]).toEqual([at(10, 45), at(11, 15)]);
  });

  it('a window with no gap long enough is busy', () => {
    const c = checkSlot(slot([10, 0], [11, 0], 45, 'window'), [event([10, 20], [10, 40])], ...WORK);
    expect(c.status).toBe('busy');
  });

  it('start ranges: the meeting may start up to the latest start', () => {
    // Start between 9:30 and 11:00 (window to 11:30) for 30 minutes, 9:30–11:00 taken.
    const c = checkSlot(slot([9, 30], [11, 30], 30, 'startBetween'), [event([9, 30], [11, 0])], ...WORK);
    expect(c.status).toBe('partly');
    expect(c.fit?.start.toISOString()).toBe(at(11, 0));
  });

  it('flags times outside working hours and lists all-day events without counting them', () => {
    const allDay = event([0, 0], [0, 0], { isAllDay: true, subject: 'Leave', start: new Date(2026, 11, 16).toISOString(), end: new Date(2026, 11, 17).toISOString() });
    const late = checkSlot(slot([18, 0], [19, 0]), [allDay], ...WORK);
    expect(late.status).toBe('free');
    expect(late.outsideHours).toBe(true);
    expect(late.allDay.map((e) => e.subject)).toEqual(['Leave']);
    expect(checkSlot(slot([17, 0], [18, 0]), [], ...WORK).outsideHours).toBe(false);
  });
});

describe('slotsRange', () => {
  it('covers whole days from the first slot to the last', () => {
    const r = slotsRange([slot([15, 0], [16, 0]), slot([9, 0], [9, 30])]);
    expect(r).toEqual({ start: new Date(2026, 11, 16).toISOString(), end: new Date(2026, 11, 17).toISOString() });
    expect(slotsRange([])).toBeNull();
  });
});
