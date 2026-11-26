import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AgendaDay, CalendarEvent } from '../api/types';
import { useApp } from '../state/app';
import { hhmm } from '../lib/dates';
import { eventTitle } from '../lib/text';

/** Days shown until "Show more": today and tomorrow. */
const SHORT = 2;
const MORE_KEY = 'agenda.showMore';

/** 09:00 on an agenda day. The app gives "2026-11-26"; the demo gives a full timestamp. */
function morningOf(date: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00` : date);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function remembered(): boolean {
  try {
    return localStorage.getItem(MORE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Second line under an agenda or calendar entry. */
export function eventWhere(e: CalendarEvent): string {
  if (e.location) return e.location;
  if (e.isOnlineMeeting) return 'Teams';
  if (e.attendees.length <= 1) return 'Blocked';
  return '';
}

/**
 * Today and tomorrow beside the mail, on the canvas with no panel around it; "Show more"
 * adds the rest of the five days (remembered). A day's label opens the calendar there.
 */
export function Agenda() {
  const app = useApp();
  const [days, setDays] = useState<AgendaDay[] | null>(null);
  const [more, setMore] = useState(remembered);
  const toggleMore = () => {
    setMore((m) => {
      try {
        localStorage.setItem(MORE_KEY, m ? '0' : '1');
      } catch {
        // Not remembered; fine.
      }
      return !m;
    });
  };

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
      {days === null && <div className="agenda-day"><span className="none">Loading…</span></div>}
      {days?.slice(0, more ? days.length : SHORT).map((d) => (
        <div key={d.date} className="agenda-day">
          <button type="button" className="label" title="Open in Calendar" onClick={() => open(morningOf(d.date))}>
            {d.label}
          </button>
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
      {days && days.length > SHORT && (
        <button type="button" className="agenda-more" aria-expanded={more} onClick={toggleMore}>
          {more ? 'Show less' : 'Show more'}
        </button>
      )}
    </aside>
  );
}
