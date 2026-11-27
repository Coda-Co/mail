import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarSearch, ChevronDown, ChevronRight, X } from 'lucide-react';
import { api } from '../api';
import type { CalendarEvent, Message, TimeProposals } from '../api/types';
import { useApp } from '../state/app';
import { checkSlot, slotsRange, type SlotCheck } from '../lib/availability';
import { hhmm, longDate, shortDate } from '../lib/dates';
import { eventTitle } from '../lib/text';
import { useToast } from './ui';
import { DayPreview } from './MeetingCard';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; result: TimeProposals };

/** Wall-clock parts of `d` in zone `tz`. */
function inZone(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), day: get('day'), month: get('month'), time: `${get('hour')}:${get('minute')}`, zone: get('timeZoneName') };
}

/** The sender wrote this in a zone whose clock differs from ours at that moment. */
function otherClock(d: Date, tz: string): boolean {
  return tz !== LOCAL_TZ && inZone(d, tz).time !== hhmm(d);
}

/** "Wednesday 16 December, 11:30–12:30", in the sender's zone (named when it isn't ours). */
export function replyWhen(start: Date, end: Date, tz: string): string {
  const a = inZone(start, tz);
  const b = inZone(end, tz);
  return `${a.weekday} ${a.day} ${a.month}, ${a.time}–${b.time}${otherClock(start, tz) ? ` ${a.zone}` : ''}`;
}

/** The meeting's span for actions: where it fits, or the start of the window. */
function meetingSpan(c: SlotCheck): { start: Date; end: Date } {
  if (c.fit) return c.fit;
  const start = new Date(c.slot.windowStart);
  return { start, end: new Date(start.getTime() + c.slot.minutes * 60000) };
}

function stripPrefixes(subject: string): string {
  return subject.replace(/^((re|fw|fwd)\s*:\s*)+/i, '').trim() || subject;
}

function StatusChip({ c }: { c: SlotCheck }) {
  const first = c.overlaps.find((e) => (c.status === 'tentative' ? true : e.myResponse !== 'tentative')) ?? c.overlaps[0];
  const more = c.overlaps.length > 1 ? ` +${c.overlaps.length - 1}` : '';
  switch (c.status) {
    case 'free':
      return <span className="times-status free">Free</span>;
    case 'partly':
      return (
        <span className="times-status free" title={`Around: ${c.overlaps.map(eventTitle).join(', ')}`}>
          Free {hhmm(c.fit!.start)}–{hhmm(c.fit!.end)}
        </span>
      );
    case 'tentative':
      return (
        <span className="times-status tentative" title={c.overlaps.map(eventTitle).join(', ')}>
          Tentative: {first ? eventTitle(first) : ''}
          {more}
        </span>
      );
    default:
      return (
        <span className="times-status busy" title={c.overlaps.map(eventTitle).join(', ')}>
          Busy: {first ? eventTitle(first) : ''}
          {more}
        </span>
      );
  }
}

function SlotRow({ c, message, onReply, onHold }: { c: SlotCheck; message: Message; onReply?: (c: SlotCheck) => void; onHold: (c: SlotCheck) => void }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const s = c.slot;
  const from = new Date(s.windowStart);
  const to = new Date(s.windowEnd);
  const latestStart = new Date(to.getTime() - s.minutes * 60000);
  const when =
    s.kind === 'exact'
      ? `${hhmm(from)}–${hhmm(to)}`
      : s.kind === 'window'
        ? `${hhmm(from)}–${hhmm(to)} · ${s.minutes} min`
        : `Start ${hhmm(from)}–${hhmm(latestStart)} · ${s.minutes} min`;
  const theirs = otherClock(from, s.timeZone) ? `${inZone(from, s.timeZone).time}–${inZone(s.kind === 'startBetween' ? latestStart : to, s.timeZone).time} ${inZone(from, s.timeZone).zone}` : '';
  const span = meetingSpan(c);
  const notes = [s.note, ...s.warnings].filter((n): n is string => !!n);
  const openInCalendar = (eventId?: string) => {
    app.setCalendarFocus({ date: span.start.toISOString(), eventId });
    app.navigate({ view: 'calendar' });
  };

  return (
    <li className={`times-slot ${c.status}`}>
      <div className="times-slot-main">
        <button type="button" className="times-when" aria-expanded={open} title={open ? 'Hide the day' : 'Show the day'} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <span className="time">{when}</span>
          {theirs && <span className="theirs">({theirs})</span>}
        </button>
        <StatusChip c={c} />
        {c.outsideHours && <span className="times-status muted">Outside working hours</span>}
        {c.allDay.map((e) => (
          <span key={e.id} className="times-status muted" title="All-day event">
            {eventTitle(e)}
          </span>
        ))}
        {c.status !== 'busy' && (
          <span className="times-actions">
            {onReply && (
              <button type="button" className="link-button" title={`Reply saying ${replyWhen(span.start, span.end, s.timeZone)} works`} onClick={() => onReply(c)}>
                Reply
              </button>
            )}
            <button type="button" className="link-button" title={`Put a hold in your calendar for ${shortDate(span.start)}, ${hhmm(span.start)}–${hhmm(span.end)}`} onClick={() => onHold(c)}>
              Hold
            </button>
          </span>
        )}
      </div>
      <div className="times-quote">“{s.quote}”</div>
      {notes.map((n) => (
        <div key={n} className="times-note">
          <AlertTriangle size={12} aria-hidden /> {n}
        </div>
      ))}
      {open && (
        <DayPreview
          meeting={{ kind: 'request', start: span.start.toISOString(), end: span.end.toISOString(), isAllDay: false, location: '' }}
          start={span.start}
          end={span.end}
          allDay={false}
          subject={`Proposed: ${stripPrefixes(message.subject)}`}
          accountId={message.accountId}
          onOpen={openInCalendar}
        />
      )}
    </li>
  );
}

/**
 * "Find times": the times this email proposes, read by the AI (only when asked), each
 * checked here against every visible calendar, with Reply and Hold.
 */
export function ProposedTimes({ message, onClose, onReply }: { message: Message; onClose: () => void; onReply?: (text: string) => void }) {
  const app = useApp();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);

  const run = useCallback(() => {
    setLoad({ state: 'loading' });
    api
      .findTimes(message.id)
      .then((result) => setLoad({ state: 'done', result }))
      .catch((e) => setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
  }, [message.id]);

  useEffect(run, [run]);

  const slots = load.state === 'done' ? load.result.slots : null;
  const range = useMemo(() => (slots ? slotsRange(slots) : null), [slots]);
  useEffect(() => {
    if (!range) return;
    let live = true;
    api
      .listEvents(range.start, range.end)
      .then((list) => live && setEvents(list))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [range?.start, range?.end, app.mailVersion]);

  const checks = useMemo(() => (slots && events ? slots.map((s) => checkSlot(s, events, app.settings.workStart, app.settings.workEnd)) : null), [slots, events, app.settings.workStart, app.settings.workEnd]);

  const days = useMemo(() => {
    const out: { key: string; label: string; items: SlotCheck[] }[] = [];
    for (const c of checks ?? []) {
      const d = new Date(c.slot.windowStart);
      const key = d.toDateString();
      let day = out.find((x) => x.key === key);
      if (!day) out.push((day = { key, label: longDate(d), items: [] }));
      day.items.push(c);
    }
    return out;
  }, [checks]);

  const reply = (c: SlotCheck) => {
    const span = meetingSpan(c);
    onReply?.(`Thanks, ${replyWhen(span.start, span.end, c.slot.timeZone)} works for me.`);
  };

  const hold = async (c: SlotCheck) => {
    const span = meetingSpan(c);
    try {
      const calendars = await api.listCalendars();
      const writable = calendars.filter((x) => !x.readOnly);
      const cal = writable.find((x) => x.accountId === message.accountId && x.isDefault) ?? writable.find((x) => x.isDefault) ?? writable[0];
      if (!cal) throw new Error('No calendar here can take new events');
      const created = await api.createEvent({
        accountId: cal.accountId,
        calendarId: cal.id,
        subject: `Hold: ${stripPrefixes(message.subject)}`,
        start: span.start.toISOString(),
        end: span.end.toISOString(),
        isAllDay: false,
        location: '',
        bodyHtml: '',
        attendees: [],
        isOnlineMeeting: false,
      });
      app.bumpMail();
      toast(`Held ${shortDate(span.start)}, ${hhmm(span.start)}–${hhmm(span.end)}`, {
        label: 'Undo',
        run: () => void api.deleteEvent(created.id).then(app.bumpMail),
      });
    } catch (e) {
      toast(`Couldn’t add the hold: ${e instanceof Error ? e.message : e}`);
    }
  };

  const needsKey = load.state === 'error' && /key/i.test(load.message);

  return (
    <section className="meeting-card times-card" aria-label="Proposed times" aria-busy={load.state === 'loading' || (load.state === 'done' && !checks)}>
      <div className="meeting-summary">
        <CalendarSearch size={18} className="meeting-icon" aria-hidden />
        <div className="meeting-facts">
          <span className="meeting-when">Proposed times</span>
          {load.state === 'loading' && <span className="meeting-where">Reading the email…</span>}
          {load.state === 'done' && <span className="meeting-where">{load.result.summary}</span>}
          {load.state === 'error' && <span className="meeting-where times-error">{load.message}</span>}
        </div>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close proposed times" title="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      {load.state === 'error' && (
        <div className="times-footer">
          {needsKey ? (
            <button type="button" className="link-button" onClick={() => app.openSettings('general')}>
              Open Settings
            </button>
          ) : (
            <button type="button" className="link-button" onClick={run}>
              Try again
            </button>
          )}
        </div>
      )}

      {load.state === 'done' && load.result.slots.length === 0 && <div className="times-empty">No specific times to check against your calendar.</div>}

      {load.state === 'done' && load.result.slots.length > 0 && !checks && <div className="meeting-preview loading" aria-hidden />}

      {days.map((d) => (
        <div key={d.key} className="times-day">
          <div className="times-day-label">{d.label}</div>
          <ul className="times-list">
            {d.items.map((c) => (
              <SlotRow key={`${c.slot.windowStart}-${c.slot.windowEnd}-${c.slot.minutes}`} c={c} message={message} onReply={onReply ? reply : undefined} onHold={hold} />
            ))}
          </ul>
        </div>
      ))}

      {load.state === 'done' && (
        <div className="times-footer">
          Read by {load.result.model} from this email only · checked against your calendars on this device ·{' '}
          <button type="button" className="link-button" onClick={run}>
            Read again
          </button>
        </div>
      )}
    </section>
  );
}
