import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover } from './ui';
import { addDays, dayShort, hhmm, monthName, monthShort, sameDay, startOfDay, startOfWeek } from '../lib/dates';
import { now } from '../lib/clock';
import { parseTime, STEP_MIN } from '../lib/timeEntry';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Thu 17 Dec 2026" */
export function pickerDate(d: Date): string {
  return `${dayShort(d.getDay())} ${d.getDate()} ${monthShort(d.getMonth())} ${d.getFullYear()}`;
}

/** A month of days to pick from, Monday first, with arrow-key movement. */
export function MonthCalendar({ value, onPick }: { value: Date; onPick: (d: Date) => void }) {
  const [month, setMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  const [focus, setFocus] = useState(() => startOfDay(value));
  const grid = useRef<HTMLDivElement>(null);
  const today = now();
  const first = startOfWeek(month);
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));

  const moveFocus = (d: Date) => {
    setFocus(d);
    if (d.getMonth() !== month.getMonth() || d.getFullYear() !== month.getFullYear()) setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };
  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>('[data-focus="true"]')?.focus({ preventScroll: true });
  }, [focus]);

  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) {
      e.preventDefault();
      moveFocus(addDays(focus, step));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const d = new Date(focus);
      d.setMonth(d.getMonth() + (e.key === 'PageUp' ? -1 : 1));
      moveFocus(d);
    }
  };

  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));

  return (
    <div className="month-picker">
      <div className="month-picker-head">
        <span className="title">
          {monthName(month.getMonth())} {month.getFullYear()}
        </span>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft size={16} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="month-picker-grid" role="grid" ref={grid} onKeyDown={onKey}>
        {WEEKDAYS.map((w) => (
          <span key={w} className="wd" aria-hidden>
            {w.slice(0, 2)}
          </span>
        ))}
        {days.map((d) => {
          const selected = sameDay(d, value);
          const isFocus = sameDay(d, focus);
          return (
            <button
              key={d.toISOString()}
              type="button"
              className={['day', d.getMonth() !== month.getMonth() && 'other', sameDay(d, today) && 'today', selected && 'selected'].filter(Boolean).join(' ')}
              aria-label={pickerDate(d)}
              aria-pressed={selected}
              tabIndex={isFocus ? 0 : -1}
              data-focus={isFocus}
              onClick={() => onPick(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      {!sameDay(value, today) && (
        <button type="button" className="link-button month-picker-today" onClick={() => onPick(startOfDay(today))}>
          Today
        </button>
      )}
    </div>
  );
}

/** A button showing the date; opens a month calendar. Picking keeps the time of day. */
export function DateButton({ value, onChange, label }: { value: Date; onChange: (d: Date) => void; label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" className="picker-field date-field" aria-label={`${label}: ${pickerDate(value)}`} aria-haspopup="dialog" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <CalendarDays size={15} aria-hidden />
        {pickerDate(value)}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={268}>
          <MonthCalendar
            value={value}
            onPick={(d) => {
              const out = new Date(d);
              out.setHours(value.getHours(), value.getMinutes(), 0, 0);
              onChange(out);
              setAnchor(null);
              anchor.focus();
            }}
          />
        </Popover>
      )}
    </>
  );
}

export interface TimeOption {
  /** Minutes after the reference day's midnight (can pass 24 h for the next day). */
  minutes: number;
  /** Shown beside the time, e.g. a duration. */
  sub?: string;
}

/**
 * A time you can type ("930", "2:30pm") or pick from a list of quarter hours. Typed times are
 * rounded to the quarter hour; arrow keys step by 15 minutes.
 */
export function TimeField({
  value,
  options,
  onChange,
  label,
}: {
  /** Minutes after the reference day's midnight. */
  value: number;
  options: TimeOption[];
  onChange: (minutes: number) => void;
  label: string;
}) {
  const shown = hhmm(new Date(2000, 0, 1, 0, value));
  const [text, setText] = useState(shown);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setText(shown), [shown]);

  // Open with the current time in view.
  useLayoutEffect(() => {
    if (!open) return;
    const sel = list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.current?.querySelector<HTMLElement>(`[data-min="${Math.floor(value / 60) * 60}"]`);
    if (sel && list.current) list.current.scrollTop = sel.offsetTop - list.current.clientHeight / 2 + sel.offsetHeight / 2;
  });

  // Typed text, read against the options: the first option at that time of day (so "9" after a
  // 22:00 start means 09:00 the next day).
  const commit = () => {
    const m = parseTime(text);
    if (m === null) return setText(shown);
    const hit = options.find((o) => o.minutes % 1440 === m) ?? options.find((o) => o.minutes === m);
    if (hit) onChange(hit.minutes);
    else setText(shown);
  };

  const step = (dir: 1 | -1) => {
    const i = options.findIndex((o) => o.minutes >= value);
    const at = i < 0 ? options.length - 1 : options[i].minutes === value ? i + dir : dir > 0 ? i : i - 1;
    const next = options[Math.max(0, Math.min(options.length - 1, at))];
    if (next) onChange(next.minutes);
  };

  return (
    <>
      <input
        ref={input}
        className="picker-field time-field"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        value={text}
        inputMode="numeric"
        onFocus={(e) => {
          e.currentTarget.select();
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            setOpen(false);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            step(e.key === 'ArrowDown' ? 1 : -1);
          } else if (e.key === 'Tab') setOpen(false);
        }}
      />
      {open && (
        <Popover anchor={input.current} onClose={() => setOpen(false)} width={options.some((o) => o.sub) ? 184 : 104}>
          <div className="time-list" role="listbox" aria-label={label} ref={list}>
            {options.map((o) => (
              <button
                key={o.minutes}
                type="button"
                role="option"
                aria-selected={o.minutes === value}
                data-min={o.minutes}
                className={`time-option${o.minutes === value ? ' selected' : ''}`}
                // Keep focus in the input, so picking doesn't run its blur first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(o.minutes);
                  setOpen(false);
                }}
              >
                <span>{hhmm(new Date(2000, 0, 1, 0, o.minutes))}</span>
                {o.sub && <span className="sub">{o.sub}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Every quarter hour of a day. */
export function dayTimes(): TimeOption[] {
  return Array.from({ length: (24 * 60) / STEP_MIN }, (_, i) => ({ minutes: i * STEP_MIN }));
}
