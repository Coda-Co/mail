import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CalendarInfo } from '../api/types';
import { useApp } from '../state/app';
import { webCalendarNote } from '../lib/webCalendar';
import { now } from '../lib/clock';
import { useTick } from '../lib/useTick';

/** Calendar's own sidebar: which accounts' calendars to show. */
export function CalendarSidebar() {
  const app = useApp();
  const { accounts } = app;
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);

  useEffect(() => {
    api.listCalendars().then(setCalendars);
  }, [accounts]);

  useTick();

  const setVisible = async (ids: string[], visible: boolean) => {
    for (const id of ids) await api.setCalendarVisible(id, visible);
    setCalendars(await api.listCalendars());
    app.bumpMail();
  };

  return (
    <aside className="side-panel cal-sidebar" aria-label="Calendars">
      <div className="side-panel-scroll">
        <div className="nav-section">Calendars</div>
        {accounts.map((a) => {
          if (a.kind === 'web' && !a.webCalendar)
            return (
              <label key={a.id} className="cal-check disabled" title="Turn on “Show this calendar in Calendar” in the account’s settings">
                <input type="checkbox" disabled />
                {a.displayName} (web only)
              </label>
            );
          const cals = calendars.filter((c) => c.accountId === a.id);
          const visible = cals.some((c) => c.visible);
          const note = webCalendarNote(a, now());
          return (
            <div key={a.id}>
              <label className={`cal-check${cals.length === 0 ? ' disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={visible}
                  disabled={cals.length === 0}
                  style={{ accentColor: a.color }}
                  onChange={(e) =>
                    setVisible(
                      cals.map((c) => c.id),
                      e.target.checked,
                    )
                  }
                />
                {a.displayName}
                {a.kind === 'web' && (
                  <>
                    {' '}
                    <span className="web-tag">web</span>
                  </>
                )}
              </label>
              {note && (
                <div className="cal-note" title={a.webCalendarError ? 'Showing the last events read' : undefined}>
                  {note}
                </div>
              )}
              {cals.length > 1 &&
                cals.map((c) => (
                  <label key={c.id} className="cal-check" style={{ paddingLeft: 34 }}>
                    <input type="checkbox" checked={c.visible} style={{ accentColor: c.color }} onChange={(e) => setVisible([c.id], e.target.checked)} />
                    {c.name}
                  </label>
                ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
