import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Clock, LoaderCircle, MapPin, Video } from 'lucide-react';
import { api } from '../api';
import type { CalendarEvent, EventField, EventInput, ResponseStatus } from '../api/types';
import { useApp } from '../state/app';
import { addDays, dayShort, hhmm, longDate, monthName, rangeTitle, sameDay, shortDate, startOfDay, startOfWeek } from '../lib/dates';
import { now } from '../lib/clock';
import { eventFill, eventSelectedFill } from '../lib/colors';
import { layoutDay } from '../lib/eventLayout';
import { EventForm } from './EventForm';
import { eventWhere } from '../components/Agenda';
import { Menu, Modal, useToast } from '../components/ui';
import { eventTitle, plural } from '../lib/text';
import { TopSearch } from '../components/TopSearch';
import { CalendarSidebar } from '../components/CalendarSidebar';
import { Resizer } from '../components/Resizer';
import { RsvpButtons, type Rsvp, type RsvpOptions } from '../components/RsvpButtons';
import { eventActions, webEventSource } from '../lib/webCalendar';
import { durationLabel } from '../lib/timeEntry';
import { isBlankHtml, stripMeetingBlock } from '../lib/meetingBody';

type Mode = 'day' | 'week' | 'month';
const HOUR = 56;

const RESPONSE_TEXT: Partial<Record<ResponseStatus, string>> = { accepted: 'You accepted', tentative: 'You tentatively accepted', declined: 'You declined' };

/** "Join Teams meeting" / "Join Zoom meeting" etc., from the join link's host. */
function joinLabel(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return 'Join meeting';
  }
  if (/teams\./.test(host)) return 'Join Teams meeting';
  if (/zoom\.us$/.test(host)) return 'Join Zoom meeting';
  if (/meet\.google\.com$/.test(host)) return 'Join Google Meet';
  if (/webex\.com$/.test(host)) return 'Join Webex meeting';
  return 'Join meeting';
}

function EventModal({ event, onClose, onChanged, onEdit, onDeleted }: { event: CalendarEvent; onClose: () => void; onChanged: (e: CalendarEvent) => void; onEdit: () => void; onDeleted: () => void }) {
  const { accountById, navigate } = useApp();
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const acc = accountById(event.accountId);
  const fromWeb = acc?.kind === 'web';
  const start = new Date(event.start);
  const end = new Date(event.end);
  const actions = eventActions(event);
  // The web calendar view doesn't carry attendees; fetch them when a meeting is opened.
  const [webAttendees, setWebAttendees] = useState(event.attendees);
  const [loadingAttendees, setLoadingAttendees] = useState(false);
  useEffect(() => {
    setWebAttendees(event.attendees);
    if (!fromWeb || event.attendees.length > 0 || !event.isOnlineMeeting) return;
    let live = true;
    setLoadingAttendees(true);
    api
      .fetchWebEventAttendees(event.accountId, event.id)
      .then((list) => {
        if (live) setWebAttendees(list);
      })
      .finally(() => {
        if (live) setLoadingAttendees(false);
      });
    return () => {
      live = false;
    };
  }, [event.id, event.accountId, event.attendees, event.isOnlineMeeting, fromWeb]);
  // The join button stands in for Teams' own "Join: https://…" block and its location line.
  const description = useMemo(() => {
    const html = event.bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '');
    const out = event.onlineMeetingUrl ? stripMeetingBlock(html) : html;
    return isBlankHtml(out) ? '' : out;
  }, [event.bodyHtml, event.onlineMeetingUrl]);
  const showLocation = !!event.location && !(event.onlineMeetingUrl && /^microsoft teams meeting$/i.test(event.location.trim()));
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  const oneDay = sameDay(start, new Date(end.getTime() - 1));
  const when = event.isAllDay
    ? oneDay
      ? `${longDate(start)} · All day`
      : `${longDate(start)} – ${longDate(addDays(end, -1))} · All day`
    : oneDay
      ? `${longDate(start)} · ${hhmm(start)} – ${hhmm(end)}`
      : `${longDate(start)} ${hhmm(start)} – ${longDate(end)} ${hhmm(end)}`;
  const attendees = [...webAttendees].sort((a, b) => (a.response === 'organizer' ? -1 : b.response === 'organizer' ? 1 : 0));
  const shown = showAll ? attendees : attendees.slice(0, 3);
  const respond = async (r: Rsvp, o: RsvpOptions) => {
    try {
      onChanged(await api.respondEvent(event.id, r, o));
    } catch (e) {
      toast(`Couldn’t respond: ${e instanceof Error ? e.message : e}`);
    }
  };
  return (
    <Modal
      className="event-modal"
      title={eventTitle(event)}
      onClose={onClose}
      footer={
        fromWeb ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose();
              // Open this event's own page in Outlook on the web (attendees, tracking), not just the inbox.
              api.openWebEvent(event.accountId, event.id).catch((e) => toast(`Couldn’t open the event: ${e instanceof Error ? e.message : e}`));
              navigate({ view: 'web', param: event.accountId });
            }}
          >
            Open event in Outlook on the web
          </button>
        ) : actions.edit || actions.delete ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                await api.deleteEvent(event.id);
                toast(event.attendees.length > 1 ? 'Event cancelled' : 'Event deleted');
                onDeleted();
              }}
            >
              {event.attendees.length > 1 ? 'Cancel event' : 'Delete'}
            </button>
            <button type="button" className="btn" onClick={onEdit}>
              Edit
            </button>
          </>
        ) : undefined
      }
    >
      <div className="modal-body event-detail">
        <span className="acc">
          <span className="acc-dot" style={{ background: acc?.color ?? event.color }} />
          {acc?.displayName}
          {fromWeb && <span className="web-tag">web</span>}
        </span>
        {fromWeb && <span className="event-source">{webEventSource(acc, now())}</span>}
        <div className="facts">
          <div className="fact">
            <Clock size={16} aria-hidden />
            <span>
              {when}
              {!event.isAllDay && oneDay && <span className="muted"> · {durationLabel(minutes)}</span>}
            </span>
          </div>
          {showLocation && (
            <div className="fact">
              <MapPin size={16} aria-hidden />
              <span>{event.location}</span>
            </div>
          )}
          {!actions.respond && event.readOnly && RESPONSE_TEXT[event.myResponse] && (
            <div className="fact">
              <Check size={16} aria-hidden />
              <span>{RESPONSE_TEXT[event.myResponse]}</span>
            </div>
          )}
        </div>
        {event.isOnlineMeeting && event.onlineMeetingUrl && (
          <button type="button" className="btn btn-primary join-meeting" onClick={() => api.openExternal(event.onlineMeetingUrl!)}>
            <Video size={16} aria-hidden />
            {joinLabel(event.onlineMeetingUrl)}
          </button>
        )}
        {actions.respond && <RsvpButtons current={event.myResponse} onRespond={respond} />}
        {loadingAttendees && attendees.length === 0 && (
          <>
            <div className="form-label" style={{ paddingTop: 6 }}>
              Attendees
            </div>
            <div className="attendees">
              <span className="muted">Loading…</span>
            </div>
          </>
        )}
        {attendees.length > 0 && (
          <>
            <div className="form-label" style={{ paddingTop: 6 }}>
              Attendees
            </div>
            <div className="attendees">
              {shown.map((a) => (
                <span key={a.address.email || a.address.name} title={a.address.email}>
                  {a.address.name || a.address.email}
                  {a.address.email && a.address.name && <span className="muted"> · {a.address.email}</span>}
                  {a.response === 'organizer' && <span className="muted"> · organiser</span>}
                  {a.response === 'declined' && <span className="muted"> · declined</span>}
                  {a.response === 'tentative' && <span className="muted"> · maybe</span>}
                </span>
              ))}
              {!showAll && attendees.length > 3 && (
                <button type="button" className="link-button muted" style={{ alignSelf: 'flex-start', color: 'var(--text-muted)' }} onClick={() => setShowAll(true)}>
                  + {attendees.length - 3} more
                </button>
              )}
            </div>
          </>
        )}
        {description && <div className="description" dangerouslySetInnerHTML={{ __html: description }} />}
      </div>
    </Modal>
  );
}

type DragKind = 'move' | 'start' | 'end';
/** An event being dragged, or dropped and waiting for the change to be confirmed. */
type Reschedule = { event: CalendarEvent; start: Date; end: Date };

/** Minutes after midnight on day, by the clock (so DST days come out right). */
function atMinute(day: Date, m: number): Date {
  const d = new Date(day);
  d.setHours(0, m, 0, 0);
  return d;
}

/** People other than you on an event: the ones a change of time would notify. */
function otherAttendees(e: CalendarEvent) {
  const me = e.organizer.email.toLowerCase();
  return e.attendees.filter((a) => a.response !== 'organizer' && (!me || a.address.email.toLowerCase() !== me));
}

/** The event as it is, at new times. */
function retimed(event: CalendarEvent, start: Date, end: Date): EventInput {
  return {
    accountId: event.accountId,
    subject: event.subject,
    start: start.toISOString(),
    end: end.toISOString(),
    isAllDay: false,
    location: event.location,
    bodyHtml: event.bodyHtml,
    attendees: event.attendees.filter((a) => a.response !== 'organizer').map((a) => a.address),
    isOnlineMeeting: event.isOnlineMeeting,
    reminderMinutes: event.reminderMinutes,
  };
}

/** Asks before a dragged or resized meeting is saved, since its attendees hear about it. */
function RescheduleModal({ change, onCancel, onSaved }: { change: Reschedule; onCancel: () => void; onSaved: (e: CalendarEvent) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { event, start, end } = change;
  const oldStart = new Date(event.start);
  const oldEnd = new Date(event.end);
  const invitees = otherAttendees(event);
  const when = (s: Date, e: Date) => `${longDate(s)}, ${hhmm(s)} – ${hhmm(e)} (${durationLabel(Math.round((e.getTime() - s.getTime()) / 60000))})`;
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.updateEvent(event.id, retimed(event, start, end)));
    } catch (e) {
      toast(`Couldn’t change the event: ${e instanceof Error ? e.message : e}`);
      onCancel();
    }
  };
  return (
    <Modal
      className="reschedule-modal"
      title={oldStart.getTime() !== start.getTime() && oldEnd.getTime() !== end.getTime() ? 'Move event?' : 'Change event time?'}
      onClose={onCancel}
      footer={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            {invitees.length > 0 ? 'Attendees get an update.' : ''}
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={save} disabled={busy}>
            {invitees.length > 0 ? 'Send update' : 'Save'}
          </button>
        </>
      }
    >
      <div className="modal-body reschedule">
        <div className="reschedule-title">{eventTitle(event)}</div>
        <div className="reschedule-row">
          <span className="form-label">From</span>
          <span className="muted">{when(oldStart, oldEnd)}</span>
        </div>
        <div className="reschedule-row">
          <span className="form-label">To</span>
          <span>{when(start, end)}</span>
        </div>
      </div>
    </Modal>
  );
}

type EventDate = 'any' | 'upcoming' | 'past' | 'nextMonth' | 'pastMonth' | 'pastYear';
const EVENT_DATES: Record<EventDate, string> = {
  any: 'Any time',
  upcoming: 'Upcoming',
  past: 'Past',
  nextMonth: 'Next 30 days',
  pastMonth: 'Past 30 days',
  pastYear: 'Past year',
};
const EVENT_FIELDS: Record<EventField, string> = { all: 'Everything', title: 'Title', people: 'Invitees' };
const FIELD_KEY = 'calendar.searchField';

function lastEventField(): EventField {
  try {
    const v = localStorage.getItem(FIELD_KEY) as EventField | null;
    if (v && v in EVENT_FIELDS) return v;
  } catch {
    // Storage unavailable: use the default.
  }
  return 'all';
}

/** The after/before bounds for a date filter, from now. */
function dateBounds(d: EventDate): { after?: string; before?: string } {
  const t = now();
  const iso = (days: number) => addDays(t, days).toISOString();
  switch (d) {
    case 'upcoming':
      return { after: t.toISOString() };
    case 'past':
      return { before: t.toISOString() };
    case 'nextMonth':
      return { after: t.toISOString(), before: iso(30) };
    case 'pastMonth':
      return { after: iso(-30), before: t.toISOString() };
    case 'pastYear':
      return { after: iso(-366), before: t.toISOString() };
    default:
      return {};
  }
}

/** Events matching the top bar's search: upcoming soonest first, then past, latest first. */
function EventResults({
  text,
  field,
  date,
  onDate,
  onOpen,
}: {
  text: string;
  field: EventField;
  date: EventDate;
  onDate: (d: EventDate) => void;
  onOpen: (e: CalendarEvent) => void;
}) {
  const app = useApp();
  const key = JSON.stringify([text, field, date]);
  const [found, setFound] = useState<{ key: string; events: CalendarEvent[]; error?: string } | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchEvents({ text, field, ...dateBounds(date), limit: 200 }).then(
        (events) => !cancelled && setFound({ key, events }),
        (e) => !cancelled && setFound({ key, events: [], error: typeof e === 'string' ? e : (e as Error)?.message || 'Search failed' }),
      );
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key, text, field, date, app.mailVersion]);

  const nowIso = now().toISOString();
  const pending = found?.key !== key;
  const events = pending ? [] : found.events;
  const upcoming = events.filter((e) => e.end > nowIso).sort((a, b) => a.start.localeCompare(b.start));
  const past = events.filter((e) => e.end <= nowIso);
  const row = (e: CalendarEvent) => {
    const start = new Date(e.start);
    return (
      <button key={e.id} type="button" className="event-result" onClick={() => onOpen(e)}>
        <span className="date">
          {shortDate(start)}
          {start.getFullYear() !== now().getFullYear() ? ` ${start.getFullYear()}` : ''}
        </span>
        <span className="time">{e.isAllDay ? 'All day' : hhmm(start)}</span>
        <span className="bar" style={{ background: e.color }} />
        <span className="text">
          <span className="title">{eventTitle(e)}</span>
          {eventWhere(e) && <span className="where">{eventWhere(e)}</span>}
        </span>
      </button>
    );
  };
  return (
    <section className="event-results" aria-label="Matching events">
      <div className="facets" role="group" aria-label="Filters">
        <button type="button" className={`chip${date !== 'any' ? ' active' : ''}`} aria-haspopup="menu" onClick={(e) => setMenu(menu ? null : e.currentTarget)}>
          Date: {EVENT_DATES[date].toLowerCase()} ▾
        </button>
        <span className="spacer" />
        {!pending && !found.error && <span className="count">{plural(events.length, 'event')}</span>}
      </div>
      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={(Object.keys(EVENT_DATES) as EventDate[]).map((d) => ({ label: EVENT_DATES[d], checked: date === d, onSelect: () => onDate(d) }))}
        />
      )}
      {pending ? (
        <div className="list-empty">
          <span className="list-searching" role="status">
            <LoaderCircle size={16} className="spin" aria-hidden />
            Searching…
          </span>
        </div>
      ) : found.error ? (
        <div className="list-empty">Search failed: {found.error}</div>
      ) : events.length === 0 ? (
        <div className="list-empty">No events match</div>
      ) : (
        <>
          {upcoming.length > 0 && <div className="section-title">Upcoming</div>}
          {upcoming.map(row)}
          {past.length > 0 && <div className="section-title">Past</div>}
          {past.map(row)}
        </>
      )}
    </section>
  );
}

export function CalendarView() {
  const app = useApp();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('week');
  const [anchor, setAnchor] = useState<Date>(() => (app.calendarFocus ? new Date(app.calendarFocus.date) : now()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(app.calendarFocus?.eventId ?? null);
  const [form, setForm] = useState<{ event?: CalendarEvent; start?: Date; allDay?: boolean } | null>(null);
  // Only where there's a calendar to add to.
  const { workStart, workEnd } = app.settings;
  const canCreate = app.graphAccounts.length > 0;
  const newEvent = (f: { start?: Date; allDay?: boolean }) => {
    if (canCreate) setForm(f);
  };
  // The quarter hour under the pointer in a day column, as minutes after midnight.
  const slotAt = (ev: { clientY: number; currentTarget: HTMLElement }) =>
    Math.max(0, Math.min(24 * 60 - 15, Math.floor((ev.clientY - ev.currentTarget.getBoundingClientRect().top) / (HOUR / 4)) * 15));
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [field, setField] = useState<EventField>(lastEventField);
  const [dateFilter, setDateFilter] = useState<EventDate>('any');
  const searching = !!query.trim() || dateFilter !== 'any';
  const pickField = (f: EventField) => {
    setField(f);
    try {
      localStorage.setItem(FIELD_KEY, f);
    } catch {
      // Not remembered; fine.
    }
  };
  const scroller = useRef<HTMLDivElement>(null);
  // Dragging an event to move it, or its top or bottom edge to change when it starts or ends.
  const [drag, setDrag] = useState<Reschedule | null>(null);
  const [confirm, setConfirm] = useState<Reschedule | null>(null);
  // The click that ends a drag mustn't also open the event or start a new one.
  const dragged = useRef(false);
  const dark = document.documentElement.dataset.theme === 'dark';

  useEffect(() => {
    if (app.calendarFocus) {
      setAnchor(new Date(app.calendarFocus.date));
      if (app.calendarFocus.eventId) setSelectedId(app.calendarFocus.eventId);
      app.setCalendarFocus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.calendarFocus]);

  const days = useMemo(() => {
    if (mode === 'day') return [startOfDay(anchor)];
    if (mode === 'week') {
      const mon = startOfWeek(anchor);
      return [0, 1, 2, 3, 4].map((i) => addDays(mon, i));
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = startOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [mode, anchor]);

  useEffect(() => {
    const start = days[0];
    const end = addDays(days[days.length - 1], 1);
    api.listEvents(start.toISOString(), end.toISOString()).then(setEvents);
  }, [days, app.mailVersion, version]);

  useLayoutEffect(() => {
    if (mode !== 'month' && scroller.current) scroller.current.scrollTop = 8 * HOUR;
  }, [mode]);

  // Web calendars refresh when Calendar opens (the core limits it to once a minute).
  useEffect(() => {
    api.refreshWebCalendars().catch(() => {});
  }, []);

  const selected = events.find((e) => e.id === selectedId) ?? null;
  const today = now();

  const step = (dir: number) => {
    if (mode === 'day') setAnchor((a) => addDays(a, dir));
    else if (mode === 'week') setAnchor((a) => addDays(a, 7 * dir));
    else setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir, 1));
  };

  const title =
    mode === 'month' ? `${monthName(anchor.getMonth())} ${anchor.getFullYear() !== today.getFullYear() ? anchor.getFullYear() : ''}`.trim() : rangeTitle(days[0], days[days.length - 1]);

  const style = (e: CalendarEvent, isSelected: boolean) => ({
    background: isSelected ? eventSelectedFill(e.color, dark) : eventFill(e.color, dark),
    border: 'none',
    borderLeft: `4px solid ${e.color}`,
    outline: isSelected ? '2px solid var(--text)' : undefined,
    outlineOffset: -1,
  });

  // Outlook shows the location under the title; online meetings without one read as Teams.
  const eventLocation = (e: CalendarEvent) => e.location || (e.isOnlineMeeting ? 'Microsoft Teams Meeting' : '');
  // A dragged event is drawn where it would go, and stays there while the change is confirmed.
  const moving = drag ?? confirm;
  const shownEvents = moving ? events.map((e) => (e.id === moving.event.id ? { ...e, start: moving.start.toISOString(), end: moving.end.toISOString() } : e)) : events;
  // Your own timed events within one day, in an account the app can write to.
  const canDrag = (e: CalendarEvent) => {
    if (e.isAllDay || !eventActions(e).edit || app.accountById(e.accountId)?.kind === 'web') return false;
    return sameDay(new Date(e.start), new Date(new Date(e.end).getTime() - 1));
  };
  const beginDrag = (ev: React.PointerEvent<HTMLElement>, e: CalendarEvent, kind: DragKind) => {
    if (ev.button !== 0 || !canDrag(e) || confirm) return;
    ev.stopPropagation();
    ev.preventDefault();
    const cols = Array.from(scroller.current?.querySelectorAll<HTMLElement>('.day-column') ?? []).map((c) => c.getBoundingClientRect());
    const colAt = (x: number) => {
      const i = cols.findIndex((r) => x >= r.left && x < r.right);
      if (i >= 0) return i;
      return cols.length && x < cols[0].left ? 0 : cols.length - 1;
    };
    const s0 = new Date(e.start);
    const e0 = new Date(e.end);
    const sMin = s0.getHours() * 60 + s0.getMinutes();
    const eMin = sameDay(s0, e0) ? e0.getHours() * 60 + e0.getMinutes() : 24 * 60;
    const len = eMin - sMin;
    const col0 = days.findIndex((d) => sameDay(d, s0));
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let moved = false;
    let cur: Reschedule = { event: e, start: s0, end: e0 };
    const onMove = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
      moved = true;
      const dMin = Math.round((m.clientY - y0) / (HOUR / 4)) * 15;
      if (kind === 'move') {
        const day = days[col0 < 0 ? 0 : Math.max(0, Math.min(days.length - 1, colAt(m.clientX)))] ?? s0;
        const st = Math.max(0, Math.min(24 * 60 - len, sMin + dMin));
        cur = { event: e, start: atMinute(day, st), end: atMinute(day, st + len) };
      } else if (kind === 'start') {
        cur = { event: e, start: atMinute(s0, Math.max(0, Math.min(eMin - 15, sMin + dMin))), end: e0 };
      } else {
        cur = { event: e, start: s0, end: atMinute(s0, Math.min(24 * 60, Math.max(sMin + 15, eMin + dMin))) };
      }
      setDrag(cur);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDrag(null);
      if (!moved) return;
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      if (cur.start.getTime() === s0.getTime() && cur.end.getTime() === e0.getTime()) return;
      // Only meetings ask first; an event that's just in your diary moves straight away.
      if (otherAttendees(e).length > 0) setConfirm(cur);
      else void moveNow(e, cur.start, cur.end, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  // Saves new times at once, drawn there before the server answers. Offers an undo.
  const moveNow = async (e: CalendarEvent, start: Date, end: Date, undoable: boolean) => {
    const was = { start: e.start, end: e.end };
    const set = (t: { start: string; end: string }) => setEvents((list) => list.map((x) => (x.id === e.id ? { ...x, ...t } : x)));
    set({ start: start.toISOString(), end: end.toISOString() });
    try {
      const saved = await api.updateEvent(e.id, retimed(e, start, end));
      setEvents((list) => list.map((x) => (x.id === saved.id ? saved : x)));
      setVersion((v) => v + 1);
      if (undoable) {
        const sameLength = end.getTime() - start.getTime() === new Date(was.end).getTime() - new Date(was.start).getTime();
        toast(sameLength ? 'Event moved' : 'Event time changed', { label: 'Undo', run: () => void moveNow(saved, new Date(was.start), new Date(was.end), false) });
      }
    } catch (err) {
      set(was);
      toast(`Couldn’t change the event: ${err instanceof Error ? err.message : err}`);
    }
  };
  const dayEvents = (d: Date) => shownEvents.filter((e) => new Date(e.start) < addDays(d, 1) && new Date(e.end) > d);
  const webTag = (e: CalendarEvent) =>
    app.accountById(e.accountId)?.kind === 'web' ? (
      <>
        {' '}
        <span className="web-tag">web</span>
      </>
    ) : null;

  const timeGrid = (
    <>
      <div className="day-labels">
        {days.map((d) => (
          <button
            key={d.toISOString()}
            type="button"
            className={`day-label${sameDay(d, today) ? ' today' : ''}`}
            onClick={() => {
              setAnchor(d);
              setMode('day');
            }}
          >
            {mode === 'day' ? longDate(d) : `${dayShort(d.getDay())} ${d.getDate()}`}
          </button>
        ))}
      </div>
      {shownEvents.some((e) => e.isAllDay) && (
        <div className="all-day-row">
          {days.map((d) => (
            <div
              key={d.toISOString()}
              className="cell"
              onClick={(ev) => {
                if (ev.target === ev.currentTarget) newEvent({ start: startOfDay(d), allDay: true });
              }}
            >
              {dayEvents(d)
                .filter((e) => e.isAllDay)
                .map((e) => (
                  <button key={e.id} type="button" className="all-day-event" style={style(e, e.id === selectedId)} onClick={() => setSelectedId(e.id)}>
                    {eventTitle(e)}
                    {webTag(e)}
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
      <div className="week-grid-scroll" ref={scroller}>
        <div className="week-grid">
          <div className="hour-labels">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h}>{h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}</div>
            ))}
          </div>
          {days.map((d) => {
            const placed = layoutDay(dayEvents(d).filter((e) => !e.isAllDay));
            const isToday = sameDay(d, today);
            return (
              <div
                key={d.toISOString()}
                className={`day-column${isToday ? ' today' : ''}`}
                style={{ height: 24 * HOUR }}
                onClick={(ev) => {
                  // Click an empty slot: a new half-hour event starting at the quarter hour clicked.
                  if (ev.target !== ev.currentTarget || dragged.current) return;
                  const start = new Date(d);
                  start.setMinutes(slotAt(ev));
                  newEvent({ start });
                }}
                onMouseMove={(ev) => {
                  // Shows where a click would put the event. Moved directly, not re-rendered.
                  const ghost = ev.currentTarget.querySelector<HTMLElement>(':scope > .slot-ghost');
                  if (!ghost) return;
                  if (ev.target !== ev.currentTarget || !canCreate) return void (ghost.style.display = 'none');
                  const m = slotAt(ev);
                  ghost.style.display = 'block';
                  ghost.style.top = `${(m / 60) * HOUR}px`;
                  ghost.dataset.time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
                }}
                onMouseLeave={(ev) => {
                  const ghost = ev.currentTarget.querySelector<HTMLElement>(':scope > .slot-ghost');
                  if (ghost) ghost.style.display = 'none';
                }}
              >
                {/* Outside working hours (Settings): shaded, still clickable to add an event. */}
                {workStart > 0 && <div className="off-hours" aria-hidden style={{ top: 0, height: (workStart / 60) * HOUR }} />}
                {workEnd < 24 * 60 && <div className="off-hours" aria-hidden style={{ top: (workEnd / 60) * HOUR, bottom: 0 }} />}
                <div className="slot-ghost" aria-hidden style={{ height: HOUR / 2 }} />
                {isToday && <div className="now-line" style={{ top: ((today.getHours() * 60 + today.getMinutes()) / 60) * HOUR }} />}
                {placed.map(({ event: e, lane, lanes }) => {
                  const s = new Date(e.start);
                  const en = new Date(e.end);
                  const startMin = sameDay(s, d) ? s.getHours() * 60 + s.getMinutes() : 0;
                  const endMin = sameDay(en, d) ? en.getHours() * 60 + en.getMinutes() : 24 * 60;
                  const height = Math.max(22, ((endMin - startMin) / 60) * HOUR - 1);
                  const width = 100 / lanes;
                  const short = endMin - startMin <= 30;
                  const draggable = canDrag(e);
                  const isMoving = moving?.event.id === e.id;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      className={`cal-event${e.myResponse === 'declined' ? ' declined' : ''}${e.myResponse === 'tentative' ? ' tentative' : ''}${draggable ? ' draggable' : ''}${isMoving ? ' moving' : ''}${short ? ' short' : ''}`}
                      style={{
                        ...style(e, e.id === selectedId),
                        top: (startMin / 60) * HOUR,
                        height,
                        left: `${lane * width}%`,
                        width: `calc(${width}% - 1px)`,
                        padding: short ? '3px 8px' : undefined,
                      }}
                      onPointerDown={draggable ? (ev) => beginDrag(ev, e, 'move') : undefined}
                      onClick={() => !dragged.current && setSelectedId(e.id)}
                      onDoubleClick={() => eventActions(e).edit && setForm({ event: e })}
                      title={`${eventTitle(e)} · ${hhmm(s)} – ${hhmm(en)}${eventWhere(e) ? ' · ' + eventWhere(e) : ''}`}
                    >
                      {draggable && <span className="cal-event-handle top" aria-hidden onPointerDown={(ev) => beginDrag(ev, e, 'start')} />}
                      {draggable && <span className="cal-event-handle bottom" aria-hidden onPointerDown={(ev) => beginDrag(ev, e, 'end')} />}
                      {isMoving && <span className="cal-event-time">{`${hhmm(s)} – ${hhmm(en)}`}</span>}
                      <span className="title">
                        {eventTitle(e)}
                        {webTag(e)}
                        {/* No room for a second line: the location follows the title. */}
                        {short && eventLocation(e) && <span className="location-inline">, {/^microsoft teams meeting$/i.test(eventLocation(e).trim()) ? 'Teams' : eventLocation(e)}</span>}
                      </span>
                      {!short && eventLocation(e) && <span className="location">{eventLocation(e)}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );

  const monthGrid = (
    <>
      <div className="month-head">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="month-grid">
        {days.map((d) => {
          const list = dayEvents(d).sort((a, b) => a.start.localeCompare(b.start));
          return (
            <div
              key={d.toISOString()}
              className={`month-cell${d.getMonth() !== anchor.getMonth() ? ' other' : ''}${sameDay(d, today) ? ' today' : ''}`}
              onClick={(ev) => {
                // Click an empty part of a day: a new event that day at 09:00.
                if (ev.target === ev.currentTarget) newEvent({ start: new Date(startOfDay(d).getTime() + 9 * 3600000) });
              }}
            >
              <button
                type="button"
                className="num"
                onClick={() => {
                  setAnchor(d);
                  setMode('day');
                }}
              >
                {d.getDate()}
              </button>
              {list.slice(0, 3).map((e) => (
                <button key={e.id} type="button" className="month-event" onClick={() => setSelectedId(e.id)} style={e.id === selectedId ? { background: eventFill(e.color, dark) } : undefined}>
                  <span className="acc-dot" style={{ background: e.color }} />
                  {!e.isAllDay && <span className="t">{hhmm(new Date(e.start))}</span>}
                  <span className="s">{eventTitle(e)}</span>
                  {webTag(e)}
                </button>
              ))}
              {list.length > 3 && <span className="month-more">{list.length - 3} more</span>}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div className="calendar-view">
      <CalendarSidebar
        anchor={anchor}
        range={days}
        onPick={(d) => {
          setQuery('');
          setDateFilter('any');
          setAnchor(d);
        }}
      />
      <Resizer variable="--sidebar-w" pane="before" label="Resize calendars" className="sidebar-resizer" />
      <div className="calendar-main">
      <TopSearch
        value={query}
        onChange={setQuery}
        placeholder={field === 'title' ? 'Words in the title' : field === 'people' ? 'Invitee name or address' : 'Search events'}
        field={{ labels: EVENT_FIELDS, value: field, onChange: pickField }}
        active={searching}
        onClear={() => {
          setQuery('');
          setDateFilter('any');
        }}
      />
      {searching ? (
        <EventResults
          text={query.trim()}
          field={field}
          date={dateFilter}
          onDate={setDateFilter}
          onOpen={(e) => {
            setQuery('');
            setDateFilter('any');
            setAnchor(new Date(e.start));
            setSelectedId(e.id);
          }}
        />
      ) : (
      <section className="week-pane" aria-label="Calendar">
        <div className="cal-header">
          <h1 className="view-title">{title}</h1>
          <button type="button" className="btn" onClick={() => setAnchor(now())}>
            Today
          </button>
          <button type="button" className="btn btn-icon" aria-label="Previous" onClick={() => step(-1)}>
            ‹
          </button>
          <button type="button" className="btn btn-icon" aria-label="Next" onClick={() => step(1)}>
            ›
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setForm({})} disabled={app.graphAccounts.length === 0}>
            New event
          </button>
        </div>
        <div className="tabs" role="tablist">
          {(['day', 'week', 'month'] as Mode[]).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={`tab${mode === m ? ' selected' : ''}`} onClick={() => setMode(m)}>
              {m === 'day' ? 'Day' : m === 'week' ? 'Work week' : 'Month'}
            </button>
          ))}
        </div>
        {mode === 'month' ? monthGrid : timeGrid}
      </section>
      )}
      </div>
      {selected && (
        <EventModal
          key={selected.id}
          event={selected}
          onClose={() => setSelectedId(null)}
          onChanged={(e) => setEvents((list) => list.map((x) => (x.id === e.id ? e : x)))}
          onEdit={() => {
            setSelectedId(null);
            setForm({ event: selected });
          }}
          onDeleted={() => {
            setSelectedId(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
      {confirm && (
        <RescheduleModal
          key={confirm.event.id}
          change={confirm}
          onCancel={() => setConfirm(null)}
          onSaved={(e) => {
            setConfirm(null);
            setEvents((list) => list.map((x) => (x.id === e.id ? e : x)));
            setVersion((v) => v + 1);
          }}
        />
      )}
      {form && (
        <EventForm
          event={form.event}
          start={form.start}
          allDay={form.allDay}
          onClose={() => setForm(null)}
          onSaved={(e) => {
            setForm(null);
            setAnchor(new Date(e.start));
            setVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
