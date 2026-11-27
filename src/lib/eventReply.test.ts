import { describe, expect, it } from 'vitest';
import type { Attendee, CalendarEvent } from '../api/types';
import { canReplyToEvent, eventReply, eventReplySubject, replyAllDiffers } from './eventReply';

const me = { name: 'Me', email: 'me@x.com' };
const org = { name: 'Org', email: 'org@x.com' };
const ann = { name: 'Ann', email: 'ann@x.com' };
const bo = { name: 'Bo', email: 'bo@x.com' };
const room = { name: 'Room 1', email: 'room1@x.com' };
const at = (address: Attendee['address'], type: Attendee['type'] = 'required', response: Attendee['response'] = 'accepted'): Attendee => ({ address, type, response });
const event = (patch: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e',
  accountId: 'a',
  calendarId: 'c',
  subject: 'Planning',
  start: '2026-11-27T10:00:00Z',
  end: '2026-11-27T11:00:00Z',
  isAllDay: false,
  location: '',
  bodyHtml: '',
  organizer: org,
  attendees: [at(org, 'required', 'organizer'), at({ name: 'ME', email: 'ME@x.com' }, 'required', 'none'), at(ann), at(bo, 'optional'), at(room, 'resource')],
  myResponse: 'none',
  isOnlineMeeting: false,
  isCancelled: false,
  color: '#000',
  readOnly: false,
  ...patch,
});

describe('event reply', () => {
  it('replies to the organiser', () => {
    expect(eventReply(event({}), me.email, 'reply')).toEqual({ to: [org], cc: [], subject: 'Re: Planning' });
  });
  it('replies all to organiser and attendees, optional on cc, without me or rooms', () => {
    expect(eventReply(event({}), me.email, 'replyAll')).toEqual({ to: [org, ann], cc: [bo], subject: 'Re: Planning' });
  });
  it('replies to everyone invited when I organised it', () => {
    const e = event({ organizer: me, attendees: [at(me, 'required', 'organizer'), at(ann), at(bo, 'optional')] });
    expect(eventReply(e, me.email, 'reply')).toEqual({ to: [ann], cc: [bo], subject: 'Re: Planning' });
    expect(replyAllDiffers(e, me.email)).toBe(false);
  });
  it('falls back to the organiser attendee when the organiser field is empty', () => {
    const e = event({ organizer: { name: '', email: '' } });
    expect(eventReply(e, me.email, 'reply').to).toEqual([org]);
  });
  it('has no one to reply to on my own appointment', () => {
    expect(canReplyToEvent(event({ organizer: me, attendees: [] }), me.email)).toBe(false);
    expect(canReplyToEvent(event({}), me.email)).toBe(true);
    expect(replyAllDiffers(event({}), me.email)).toBe(true);
  });
  it('does not stack Re:', () => expect(eventReplySubject('RE: Planning')).toBe('RE: Planning'));
});
