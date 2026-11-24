import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AgendaDay, CalendarEvent } from '../api/types';
import { useApp } from '../state/app';
import { hhmm, shortDate } from '../lib/dates';
import { now } from '../lib/clock';
import { eventTitle } from '../lib/text';

/** Second line under an agenda or calendar entry. */
export function eventWhere(e: CalendarEvent): string {
  if (e.location) return e.location;
  if (e.isOnlineMeeting) return 'Teams';
  if (e.attendees.length <= 1) return 'Blocked';
  return '';
}

export function Agenda() {
  const app = useApp();
  const [days, setDays] = useState<AgendaDay[] | null>(null);

  useEffect(() => {
    const load = () => api.agenda(5).then(setDays).catch(() => setDays([]));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [app.mailVersion, app.accounts.length]);

  const open = (date: string, eventId?: string) => {
    app.setCalendarFocus({ date, eventId });
    app.navigate({ view: 'calendar' });
  };

  return (
    <aside className="agenda" aria-label="Agenda">
      <div className="agenda-header">
        <button type="button" onClick={() => open(now().toISOString())}>
          Agenda
        </button>
        <span className="date">{shortDate(now())}</span>
      </div>
      {days === null && <div className="agenda-day"><span className="none">Loading…</span></div>}
      {days?.map((d) => (
        <div key={d.date} className="agenda-day">
          <span className="label">{d.label}</span>
          {d.events.length === 0 && <span className="none">{d.label === 'Today' ? 'Nothing else today' : 'Nothing scheduled'}</span>}
          {d.events.map((e) => (
            <button key={e.id} type="button" className="agenda-event" onClick={() => open(e.start, e.id)}>
              <span className="time">{e.isAllDay ? 'All day' : hhmm(new Date(e.start))}</span>
              <span className="bar" style={{ background: e.color }} />
              <span className="text">
                <span className="title">{eventTitle(e)}</span>
                {eventWhere(e) && <span className="where">{eventWhere(e)}</span>}
              </span>
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
