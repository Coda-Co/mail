import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import type { CalendarEvent, EventField, ResponseStatus } from '../api/types';
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
          <span>{longDate(start)}</span>
          <span>{event.isAllDay ? 'All day' : `${hhmm(start)} – ${hhmm(end)}`}</span>
          {event.location && <span>{event.location}</span>}
          {!actions.respond && event.readOnly && RESPONSE_TEXT[event.myResponse] && <span>{RESPONSE_TEXT[event.myResponse]}</span>}
          {event.isOnlineMeeting && event.onlineMeetingUrl && (
            <button type="button" className="link-button" style={{ alignSelf: 'flex-start', display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={() => api.openExternal(event.onlineMeetingUrl!)}>
              {joinLabel(event.onlineMeetingUrl)} <ExternalLink size={13} />
            </button>
          )}
        </div>
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
        {event.bodyHtml && <div className="description" dangerouslySetInnerHTML={{ __html: event.bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '') }} />}
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
  const [mode, setMode] = useState<Mode>('week');
  const [anchor, setAnchor] = useState<Date>(() => (app.calendarFocus ? new Date(app.calendarFocus.date) : now()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(app.calendarFocus?.eventId ?? null);
  const [form, setForm] = useState<{ event?: CalendarEvent; start?: Date; allDay?: boolean } | null>(null);
  // Only where there's a calendar to add to.
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
  const dayEvents = (d: Date) => events.filter((e) => new Date(e.start) < addDays(d, 1) && new Date(e.end) > d);
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
      {events.some((e) => e.isAllDay) && (
        <div className="all-day-row">
          {days.map((d) => (
            <div
              key={d.toISOString()}
              className="cell"
              onDoubleClick={(ev) => {
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
                onDoubleClick={(ev) => {
                  // Double-click an empty slot: a new half-hour event starting at the quarter hour clicked.
                  if (ev.target !== ev.currentTarget) return;
                  const start = new Date(d);
                  start.setMinutes(slotAt(ev));
                  newEvent({ start });
                }}
                onMouseMove={(ev) => {
                  // Shows where a double-click would put the event. Moved directly, not re-rendered.
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
                  return (
                    <button
                      key={e.id}
                      type="button"
                      className={`cal-event${e.myResponse === 'declined' ? ' declined' : ''}${e.myResponse === 'tentative' ? ' tentative' : ''}`}
                      style={{
                        ...style(e, e.id === selectedId),
                        top: (startMin / 60) * HOUR,
                        height,
                        left: `${lane * width}%`,
                        width: `calc(${width}% - 1px)`,
                        padding: short ? '3px 8px' : undefined,
                      }}
                      onClick={() => setSelectedId(e.id)}
                      onDoubleClick={() => eventActions(e).edit && setForm({ event: e })}
                      title={`${eventTitle(e)} · ${hhmm(s)} – ${hhmm(en)}${eventWhere(e) ? ' · ' + eventWhere(e) : ''}`}
                    >
                      <span className="title">
                        {eventTitle(e)}
                        {webTag(e)}
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
              onDoubleClick={(ev) => {
                // Double-click a day: a new event that day at 09:00.
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
      <CalendarSidebar />
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
