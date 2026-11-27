import { useEffect, useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { api } from '../api';
import type { CalendarEvent, Message, MeetingInfo } from '../api/types';
import { useApp } from '../state/app';
import { addDays, dayShort, hhmm, monthName, monthShort, sameDay, startOfDay } from '../lib/dates';
import { eventFill, eventPendingFill } from '../lib/colors';
import { layoutDay } from '../lib/eventLayout';
import { eventActions, isPending } from '../lib/webCalendar';
import { eventTitle } from '../lib/text';
import { useToast } from './ui';
import { RsvpButtons, type Rsvp, type RsvpOptions } from './RsvpButtons';

const HOUR = 40;

/** "Wednesday 2 December 2026, 10:00 – 11:00", "Wednesday 2 December 2026, all day", or a span of days. */
export function meetingWhen(start: Date, end: Date, allDay: boolean): string {
  const day = (d: Date) => `${dayShort(d.getDay())} ${d.getDate()} ${monthName(d.getMonth())} ${d.getFullYear()}`;
  const shortDay = (d: Date) => `${dayShort(d.getDay())} ${d.getDate()} ${monthShort(d.getMonth())}`;
  if (allDay) {
    const last = addDays(end, -1);
    return end.getTime() - start.getTime() <= 86400000 || sameDay(start, last) ? `${day(start)}, all day` : `${shortDay(start)} – ${day(last)}, all day`;
  }
  if (sameDay(start, end) || (end.getHours() === 0 && end.getMinutes() === 0 && end.getTime() - start.getTime() <= 86400000)) {
    return `${day(start)}, ${hhmm(start)} – ${hhmm(end)}`;
  }
  return `${shortDay(start)}, ${hhmm(start)} – ${shortDay(end)} ${end.getFullYear()}, ${hhmm(end)}`;
}

const STATUS: Partial<Record<MeetingInfo['kind'], string>> = { cancelled: 'Cancelled', accepted: 'Accepted', tentative: 'Tentative', declined: 'Declined' };

/**
 * Above a meeting message's body: when and where, Accept / Tentative / Decline, and that part of the
 * day from every visible calendar (all accounts), so a clash shows before answering.
 */
export function MeetingCard({ message, onChanged }: { message: Message; onChanged: (m: Message) => void }) {
  const meeting = message.meeting!;
  const event = meeting.event;
  const app = useApp();
  const toast = useToast();
  // The calendar's copy is current (moved meetings); the message's own times otherwise.
  const start = new Date(event?.start || meeting.start);
  const end = new Date(event?.end || meeting.end);
  const allDay = event?.isAllDay ?? meeting.isAllDay;
  const location = event?.location || meeting.location || (event?.isOnlineMeeting ? 'Microsoft Teams meeting' : '');
  const valid = !isNaN(start.getTime()) && !isNaN(end.getTime());
  const isRequest = meeting.kind === 'request' || meeting.kind === 'other';
  const cancelled = meeting.kind === 'cancelled' || !!event?.isCancelled;
  const canRespond = isRequest && !cancelled && !!event && eventActions(event).respond;

  const respond = async (r: Rsvp, o: RsvpOptions) => {
    if (!event) return;
    try {
      await api.respondEvent(event.id, r, o);
      onChanged(await api.getMessage(message.id));
    } catch (e) {
      toast(`Couldn’t respond: ${e instanceof Error ? e.message : e}`);
    }
  };

  const openInCalendar = (eventId?: string) => {
    if (!valid) return;
    app.setCalendarFocus({ date: start.toISOString(), eventId });
    app.navigate({ view: 'calendar' });
  };

  const status = STATUS[cancelled ? 'cancelled' : meeting.kind];

  return (
    <section className={cancelled ? 'meeting-card cancelled' : 'meeting-card'} aria-label="Meeting">
      <div className="meeting-summary">
        <CalendarDays size={18} className="meeting-icon" aria-hidden />
        <div className="meeting-facts">
          <span className="meeting-when">{valid ? meetingWhen(start, end, allDay) : 'Time not given'}</span>
          {location && <span className="meeting-where">{location}</span>}
        </div>
        {status && <span className={`meeting-status ${cancelled ? 'cancelled' : meeting.kind}`}>{status}</span>}
        {valid && (
          <button type="button" className="link-button meeting-open" onClick={() => openInCalendar(event?.id)}>
            Open in Calendar
          </button>
        )}
      </div>
      {canRespond && <RsvpButtons className="meeting-rsvp" current={event.myResponse} onRespond={respond} />}
      {valid && isRequest && !cancelled && <DayPreview meeting={meeting} start={start} end={end} allDay={allDay} subject={message.subject} accountId={message.accountId} onOpen={openInCalendar} />}
    </section>
  );
}

/** A few hours either side of the meeting, with every visible calendar's events, like Outlook's invitation preview. */
export function DayPreview({
  meeting,
  start,
  end,
  allDay,
  subject,
  accountId,
  onOpen,
}: {
  meeting: MeetingInfo;
  start: Date;
  end: Date;
  allDay: boolean;
  subject: string;
  accountId: string;
  onOpen: (eventId?: string) => void;
}) {
  const app = useApp();
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const day = startOfDay(start);
  const dayMs = day.getTime();
  const dark = document.documentElement.dataset.theme === 'dark';

  useEffect(() => {
    let live = true;
    api
      .listEvents(new Date(dayMs).toISOString(), addDays(new Date(dayMs), 1).toISOString())
      .then((list) => live && setEvents(list))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [dayMs, app.mailVersion]);

  // The invitation itself, from the calendar when it's there (hidden calendar or not synced: drawn from the message).
  const inviteId = meeting.event?.id ?? meeting.eventId;
  const all = useMemo(() => {
    const list = (events ?? []).filter((e) => e.id !== inviteId);
    const acc = app.accountById(accountId);
    const invite: CalendarEvent = meeting.event ?? {
      id: inviteId ?? 'invite',
      accountId,
      calendarId: '',
      subject,
      start: start.toISOString(),
      end: end.toISOString(),
      isAllDay: allDay,
      location: meeting.location,
      bodyHtml: '',
      organizer: { name: '', email: '' },
      attendees: [],
      myResponse: 'none',
      isOnlineMeeting: false,
      isCancelled: false,
      color: acc?.color ?? '#0B5CC4',
      readOnly: true,
    };
    return [...list, invite];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, meeting, inviteId, accountId, subject, start.getTime(), end.getTime(), allDay]);

  if (!events) return <div className="meeting-preview loading" aria-hidden />;

  const allDayEvents = all.filter((e) => e.isAllDay);
  const timed = all.filter((e) => !e.isAllDay);
  // An hour before to an hour after (at least four hours), within the day.
  const dayEnd = addDays(day, 1).getTime();
  let from = allDay ? 9 : Math.max(0, start.getHours() - 1);
  let to = allDay ? 17 : Math.min(24, Math.ceil((Math.min(end.getTime(), dayEnd) - dayMs) / 3600000) + 1);
  if (to - from < 4) {
    to = Math.min(24, from + 4);
    from = Math.max(0, to - 4);
  }
  const winStart = dayMs + from * 3600000;
  const winEnd = dayMs + to * 3600000;
  const shown = timed.filter((e) => new Date(e.end).getTime() > winStart && new Date(e.start).getTime() < winEnd);
  const placed = layoutDay(shown);
  const y = (t: number) => ((Math.min(Math.max(t, winStart), winEnd) - winStart) / 3600000) * HOUR;
  const accountName = (e: CalendarEvent) => app.accountById(e.accountId)?.displayName ?? '';
  const isInvite = (e: CalendarEvent) => e.id === (inviteId ?? 'invite');
  const label = (e: CalendarEvent) => `${eventTitle(e)} · ${hhmm(new Date(e.start))}–${hhmm(new Date(e.end))}${accountName(e) ? ` · ${accountName(e)}` : ''}`;

  return (
    <div className="meeting-preview">
      {allDayEvents.length > 0 && (
        <div className="meeting-preview-allday">
          {allDayEvents.map((e) => (
            <button
              key={e.id}
              type="button"
              className={['meeting-preview-event', isInvite(e) && 'invite', isPending(e) && 'pending'].filter(Boolean).join(' ')}
              style={{ background: isPending(e) ? eventPendingFill(e.color, dark) : eventFill(e.color, dark), borderLeftColor: e.color }}
              title={`${eventTitle(e)} · all day${accountName(e) ? ` · ${accountName(e)}` : ''}`}
              onClick={() => onOpen(isInvite(e) && !meeting.event ? undefined : e.id)}
            >
              <span className="title">{eventTitle(e)}</span>
              {accountName(e) && <span className="acc">{accountName(e)}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="meeting-preview-grid" style={{ height: (to - from) * HOUR }}>
        {Array.from({ length: to - from }, (_, i) => (
          <div key={i} className="meeting-preview-hour" style={{ top: i * HOUR, height: HOUR }}>
            <span>{String((from + i) % 24).padStart(2, '0')}:00</span>
          </div>
        ))}
        <div className="meeting-preview-events">
          {placed.map(({ event: e, lane, lanes }) => {
            const top = y(new Date(e.start).getTime());
            const height = Math.max(16, y(new Date(e.end).getTime()) - top - 1);
            const declined = e.myResponse === 'declined';
            return (
              <button
                key={e.id}
                type="button"
                className={['meeting-preview-event', isInvite(e) && 'invite', declined && 'declined', isPending(e) && 'pending'].filter(Boolean).join(' ')}
                style={{
                  top,
                  height,
                  left: `calc(${(lane / lanes) * 100}% + 1px)`,
                  width: `calc(${100 / lanes}% - 2px)`,
                  background: isPending(e) ? eventPendingFill(e.color, dark) : eventFill(e.color, dark),
                  borderLeftColor: e.color,
                }}
                title={label(e)}
                onClick={() => onOpen(isInvite(e) && !meeting.event ? undefined : e.id)}
              >
                <span className="title">{eventTitle(e)}</span>
                {height >= 28 && accountName(e) && <span className="acc">{accountName(e)}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
