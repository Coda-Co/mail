import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../api';
import type { CalendarEvent, ResponseStatus } from '../api/types';
import { useApp } from '../state/app';
import { addDays, dayShort, hhmm, longDate, monthName, rangeTitle, sameDay, startOfDay, startOfWeek } from '../lib/dates';
import { now } from '../lib/clock';
import { eventBorder, eventFill, eventSelectedFill } from '../lib/colors';
import { EventForm } from './EventForm';
import { eventWhere } from '../components/Agenda';
import { Modal, useToast } from '../components/ui';
import { eventTitle } from '../lib/text';

type Mode = 'day' | 'week' | 'month';
const HOUR = 56;

interface Placed {
  event: CalendarEvent;
  lane: number;
  lanes: number;
}

/** Side-by-side lanes for overlapping events in one day. */
function layoutDay(events: CalendarEvent[]): Placed[] {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  const placed: Placed[] = [];
  let group: Placed[] = [];
  let groupEnd = '';
  const flush = () => {
    const lanes = Math.max(1, ...group.map((p) => p.lane + 1));
    group.forEach((p) => (p.lanes = lanes));
    group = [];
  };
  for (const e of sorted) {
    if (group.length && e.start >= groupEnd) flush();
    const used = new Set(group.filter((p) => p.event.end > e.start).map((p) => p.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    const p = { event: e, lane, lanes: 1 };
    group.push(p);
    placed.push(p);
    if (e.end > groupEnd) groupEnd = e.end;
  }
  flush();
  return placed;
}

function EventModal({ event, onClose, onChanged, onEdit, onDeleted }: { event: CalendarEvent; onClose: () => void; onChanged: (e: CalendarEvent) => void; onEdit: () => void; onDeleted: () => void }) {
  const { accountById } = useApp();
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const acc = accountById(event.accountId);
  const start = new Date(event.start);
  const end = new Date(event.end);
  const isOrganizer = event.myResponse === 'organizer';
  const attendees = [...event.attendees].sort((a, b) => (a.response === 'organizer' ? -1 : b.response === 'organizer' ? 1 : 0));
  const shown = showAll ? attendees : attendees.slice(0, 3);
  const respond = async (r: 'accepted' | 'tentative' | 'declined') => {
    try {
      onChanged(await api.respondEvent(event.id, r));
    } catch (e) {
      toast(`Couldn’t respond: ${e instanceof Error ? e.message : e}`);
    }
  };
  const rsvp: [Exclude<ResponseStatus, 'none' | 'organizer'>, string][] = [
    ['accepted', 'Going'],
    ['tentative', 'Maybe'],
    ['declined', 'No'],
  ];
  return (
    <Modal
      title={eventTitle(event)}
      onClose={onClose}
      footer={
        isOrganizer ? (
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
        </span>
        <div className="facts">
          <span>{longDate(start)}</span>
          <span>{event.isAllDay ? 'All day' : `${hhmm(start)} – ${hhmm(end)}`}</span>
          {event.location && <span>{event.location}</span>}
          {event.isOnlineMeeting && event.onlineMeetingUrl && (
            <button type="button" className="link-button" style={{ alignSelf: 'flex-start', display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={() => api.openExternal(event.onlineMeetingUrl!)}>
              Join Teams meeting <ExternalLink size={13} />
            </button>
          )}
        </div>
        {!isOrganizer && (
          <div className="rsvp">
            {rsvp.map(([r, label]) => (
              <button key={r} type="button" className={event.myResponse === r ? 'on' : ''} aria-pressed={event.myResponse === r} onClick={() => respond(r)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {attendees.length > 0 && (
          <>
            <div className="form-label" style={{ paddingTop: 6 }}>
              Attendees
            </div>
            <div className="attendees">
              {shown.map((a) => (
                <span key={a.address.email} title={a.address.email}>
                  {a.address.name || a.address.email}
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

export function CalendarView() {
  const app = useApp();
  const [mode, setMode] = useState<Mode>('week');
  const [anchor, setAnchor] = useState<Date>(() => (app.calendarFocus ? new Date(app.calendarFocus.date) : now()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(app.calendarFocus?.eventId ?? null);
  const [form, setForm] = useState<{ event?: CalendarEvent; start?: Date } | null>(null);
  const [version, setVersion] = useState(0);
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
    border: isSelected ? `2px solid ${e.color}` : `1px solid ${eventBorder(e.color, dark)}`,
  });

  const dayEvents = (d: Date) => events.filter((e) => new Date(e.start) < addDays(d, 1) && new Date(e.end) > d);

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
            <div key={d.toISOString()} className="cell">
              {dayEvents(d)
                .filter((e) => e.isAllDay)
                .map((e) => (
                  <button key={e.id} type="button" className="all-day-event" style={style(e, e.id === selectedId)} onClick={() => setSelectedId(e.id)}>
                    {eventTitle(e)}
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
                  if (ev.target !== ev.currentTarget) return;
                  const y = ev.nativeEvent.offsetY;
                  const start = new Date(d);
                  start.setMinutes(Math.floor(y / (HOUR / 2)) * 30);
                  setForm({ start });
                }}
              >
                {isToday && <div className="now-line" style={{ top: ((today.getHours() * 60 + today.getMinutes()) / 60) * HOUR }} />}
                {placed.map(({ event: e, lane, lanes }) => {
                  const s = new Date(e.start);
                  const en = new Date(e.end);
                  const startMin = sameDay(s, d) ? s.getHours() * 60 + s.getMinutes() : 0;
                  const endMin = sameDay(en, d) ? en.getHours() * 60 + en.getMinutes() : 24 * 60;
                  const height = Math.max(22, ((endMin - startMin) / 60) * HOUR - 4);
                  const width = 100 / lanes;
                  const short = endMin - startMin <= 30;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      className={`cal-event${e.myResponse === 'declined' ? ' declined' : ''}${e.myResponse === 'tentative' ? ' tentative' : ''}`}
                      style={{
                        ...style(e, e.id === selectedId),
                        top: (startMin / 60) * HOUR + 2,
                        height,
                        left: `calc(${lane * width}% + 4px)`,
                        width: `calc(${width}% - 8px)`,
                        padding: short ? '3px 8px' : undefined,
                      }}
                      onClick={() => setSelectedId(e.id)}
                      onDoubleClick={() => e.myResponse === 'organizer' && setForm({ event: e })}
                      title={`${eventTitle(e)} · ${hhmm(s)} – ${hhmm(en)}${eventWhere(e) ? ' · ' + eventWhere(e) : ''}`}
                    >
                      <span className="title">{eventTitle(e)}</span>
                      {!short && (
                        <span className="time">
                          {hhmm(s)} – {hhmm(en)}
                        </span>
                      )}
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
            <div key={d.toISOString()} className={`month-cell${d.getMonth() !== anchor.getMonth() ? ' other' : ''}${sameDay(d, today) ? ' today' : ''}`}>
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
          onClose={() => setForm(null)}
          onSaved={(e) => {
            setForm(null);
            setSelectedId(e.id);
            setAnchor(new Date(e.start));
            setVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
