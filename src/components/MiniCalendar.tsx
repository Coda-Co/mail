import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../state/app';
import { addDays, monthName, sameDay, startOfDay } from '../lib/dates';
import { miniMonthDays } from '../lib/miniMonth';
import { now } from '../lib/clock';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Two-month overview at the top of Calendar's sidebar, like Outlook's date picker.
 * Days with events are bold, the days the main view shows are shaded, and
 * clicking a day moves the main view there.
 */
export function MiniCalendar({ anchor, range, onPick }: { anchor: Date; range: Date[]; onPick: (d: Date) => void }) {
  const { mailVersion } = useApp();
  const [shown, setShown] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const next = new Date(shown.getFullYear(), shown.getMonth() + 1, 1);

  // Follow the main view when it moves outside the two months shown.
  useEffect(() => {
    const a = new Date(anchor.getFullYear(), anchor.getMonth(), 1).getTime();
    if (a !== shown.getTime() && a !== next.getTime()) setShown(new Date(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  const months = useMemo(
    () => [
      { date: shown, days: miniMonthDays(shown.getFullYear(), shown.getMonth(), true) },
      { date: next, days: miniMonthDays(next.getFullYear(), next.getMonth()) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown.getTime()],
  );

  const [busy, setBusy] = useState<Set<string>>(new Set());
  useEffect(() => {
    const start = months[0].days[0];
    const lastDays = months[1].days;
    const end = addDays(lastDays[lastDays.length - 1], 1);
    let live = true;
    api
      .listEvents(start.toISOString(), end.toISOString())
      .then((events) => {
        if (!live) return;
        const keys = new Set<string>();
        for (const e of events) {
          const s = new Date(e.start);
          // An end at midnight belongs to the day before (all-day events end the next midnight).
          const last = new Date(new Date(e.end).getTime() - 1);
          for (let d = startOfDay(s); d <= last && d < end; d = addDays(d, 1)) keys.add(dayKey(d));
          keys.add(dayKey(s));
        }
        setBusy(keys);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [months, mailVersion]);

  const today = now();
  const inRange = (d: Date) => range.some((r) => sameDay(r, d));
  const move = (dir: number) => setShown((s) => new Date(s.getFullYear(), s.getMonth() + dir, 1));

  return (
    <div className="mini-cal">
      {months.map(({ date, days }, i) => (
        <div key={date.getTime()} className="mini-month">
          <div className="mini-head">
            {i === 0 && (
              <button type="button" className="mini-nav" aria-label="Previous month" onClick={() => move(-1)}>
                <ChevronLeft size={16} />
              </button>
            )}
            <span className="mini-title">
              {monthName(date.getMonth())} {date.getFullYear()}
            </span>
            {i === 0 && (
              <button type="button" className="mini-nav" aria-label="Next month" onClick={() => move(1)}>
                <ChevronRight size={16} />
              </button>
            )}
          </div>
          <div className="mini-grid" role="grid" aria-label={`${monthName(date.getMonth())} ${date.getFullYear()}`}>
            {WEEKDAYS.map((w) => (
              <span key={w} className="mini-dow" aria-hidden>
                {w}
              </span>
            ))}
            {days.map((d) => {
              const cls = [
                'mini-day',
                d.getMonth() !== date.getMonth() && 'other',
                busy.has(dayKey(d)) && 'busy',
                inRange(d) && 'in-range',
                sameDay(d, today) && 'today',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={d.getTime()}
                  type="button"
                  className={cls}
                  aria-current={sameDay(d, today) ? 'date' : undefined}
                  aria-label={d.toDateString()}
                  onClick={() => onPick(d)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
