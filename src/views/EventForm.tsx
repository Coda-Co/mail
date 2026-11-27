import { useState } from 'react';
import { api } from '../api';
import type { Address, CalendarEvent, EventInput } from '../api/types';
import { useApp } from '../state/app';
import { Modal } from '../components/ui';
import { AddressField } from '../components/AddressField';
import { RichEditor } from '../components/RichEditor';
import { DateButton, TimeField, dayTimes, type TimeOption } from '../components/DateTimePicker';
import { addDays, sameDay, startOfDay } from '../lib/dates';
import { now } from '../lib/clock';
import { durationLabel, snapDate, STEP_MIN } from '../lib/timeEntry';

const MIN = 60000;
const DEFAULT_MIN = 30;

/** The next half hour. */
function defaultStart(): Date {
  const n = now();
  const d = new Date(n);
  d.setMinutes(n.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

const minutesInto = (d: Date, day: Date) => Math.round((d.getTime() - startOfDay(day).getTime()) / MIN);
const atMinutes = (day: Date, m: number) => new Date(startOfDay(day).getTime() + m * MIN);

export function EventForm({
  event,
  start,
  allDay: allDayAt,
  onClose,
  onSaved,
}: {
  event?: CalendarEvent;
  start?: Date;
  /** A new all-day event on start's day. */
  allDay?: boolean;
  onClose: () => void;
  onSaved: (e: CalendarEvent) => void;
}) {
  const { graphAccounts } = useApp();
  const s0 = event ? new Date(event.start) : snapDate(start ?? defaultStart());
  const e0 = event ? new Date(event.end) : allDayAt ? addDays(startOfDay(s0), 1) : new Date(s0.getTime() + DEFAULT_MIN * MIN);
  const [accountId, setAccountId] = useState(event?.accountId ?? graphAccounts[0]?.id ?? '');
  const [subject, setSubject] = useState(event?.subject ?? '');
  const [allDay, setAllDay] = useState(event?.isAllDay ?? !!allDayAt);
  // Timed: start and end instants. All day: the first and last day (inclusive), at midnight.
  const [from, setFrom] = useState(allDay ? startOfDay(s0) : s0);
  const [to, setTo] = useState(allDay ? addDays(startOfDay(e0), -1) : e0);
  const [location, setLocation] = useState(event?.location ?? '');
  const [attendees, setAttendees] = useState<Address[]>(event?.attendees.filter((a) => a.response !== 'organizer').map((a) => a.address) ?? []);
  // New invitations are Teams meetings unless unticked; existing events keep their setting.
  const [online, setOnline] = useState(event?.isOnlineMeeting ?? true);
  const [reminder, setReminder] = useState(event?.reminderMinutes ?? 15);
  const [body, setBody] = useState(event?.bodyHtml ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A new Teams meeting with no one invited is usually a slip: the first Save asks, the second saves.
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const noInvitees = !event && online && attendees.length === 0;
  const changeAttendees = (list: Address[]) => {
    setAttendees(list);
    setConfirmEmpty(false);
  };

  const toggleAllDay = (v: boolean) => {
    setAllDay(v);
    if (v) {
      setFrom(startOfDay(from));
      // An event ending at midnight ends the day before.
      setTo(startOfDay(to.getTime() === startOfDay(to).getTime() && to > from ? addDays(to, -1) : to));
    } else {
      // Back to a timed event: 09:00 for half an hour on the first day.
      const s = atMinutes(from, 9 * 60);
      setFrom(s);
      setTo(new Date(s.getTime() + DEFAULT_MIN * MIN));
    }
  };

  // Moving the start keeps the length; so does a new start date.
  const moveStart = (s: Date) => {
    if (allDay) {
      const days = Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86400000);
      setFrom(startOfDay(s));
      setTo(addDays(startOfDay(s), Math.max(0, days)));
      return;
    }
    const len = Math.max(STEP_MIN * MIN, to.getTime() - from.getTime());
    setFrom(s);
    setTo(new Date(s.getTime() + len));
  };

  // End times: each quarter hour after the start, up to a day later, with how long that makes it.
  const startMin = minutesInto(from, from);
  const endOptions: TimeOption[] = Array.from({ length: 1440 / STEP_MIN }, (_, i) => {
    const len = (i + 1) * STEP_MIN;
    return { minutes: startMin + len, sub: durationLabel(len) };
  });
  const lengthMin = Math.round((to.getTime() - from.getTime()) / MIN);
  const multiDay = !sameDay(from, new Date(to.getTime() - 1));

  const save = async () => {
    setError(null);
    const start = allDay ? startOfDay(from) : from;
    const end = allDay ? addDays(startOfDay(to), 1) : to;
    if (end <= start) return setError('The end must be after the start.');
    if (noInvitees && !confirmEmpty) return setConfirmEmpty(true);
    const input: EventInput = {
      accountId,
      subject: subject.trim(),
      start: start.toISOString(),
      end: end.toISOString(),
      isAllDay: allDay,
      location,
      bodyHtml: body,
      attendees,
      isOnlineMeeting: online,
      reminderMinutes: reminder,
    };
    setBusy(true);
    try {
      onSaved(event ? await api.updateEvent(event.id, input) : await api.createEvent(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={event ? 'Edit event' : 'New event'}
      onClose={onClose}
      footer={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            {attendees.length > 0 ? (event ? 'Attendees get an update.' : 'Invitations are sent when you save.') : ''}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !accountId}>
            {attendees.length > 0 && !event ? 'Send' : noInvitees && confirmEmpty ? 'Save without attendees' : 'Save'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {noInvitees && confirmEmpty && (
          <div className="form-warning" role="alert">
            No one is invited to this meeting. Add attendees above, or save it to your calendar only.
          </div>
        )}
        <div className="form-row">
          <label htmlFor="ev-title">Title</label>
          <input id="ev-title" className="input" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Add a title" />
        </div>
        <div className="form-row">
          <span className="form-label">Attendees</span>
          <div className="input" style={{ display: 'flex' }}>
            <AddressField label="Attendees" value={attendees} onChange={changeAttendees} />
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="ev-account">Calendar</label>
          <select id="ev-account" className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!!event}>
            {graphAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <span className="form-label">When</span>
          <div className="when-row">
            <DateButton label={allDay ? 'First day' : 'Date'} value={from} onChange={moveStart} />
            {allDay ? (
              <>
                <span className="when-sep">to</span>
                <DateButton label="Last day" value={to} onChange={(d) => setTo(startOfDay(d))} />
              </>
            ) : (
              <>
                <TimeField label="Start time" value={startMin} options={dayTimes()} onChange={(m) => moveStart(atMinutes(from, m))} />
                <span className="when-sep">–</span>
                <TimeField
                  label="End time"
                  value={minutesInto(to, from)}
                  options={lengthMin > 0 && lengthMin <= 1440 && lengthMin % STEP_MIN === 0 ? endOptions : [{ minutes: minutesInto(to, from) }, ...endOptions]}
                  onChange={(m) => setTo(atMinutes(from, m))}
                />
                {multiDay && <DateButton label="End date" value={to} onChange={(d) => setTo(d)} />}
                {lengthMin > 0 && <span className="when-length">{durationLabel(lengthMin)}</span>}
              </>
            )}
          </div>
        </div>
        <div className="form-inline">
          <label className="check">
            <input type="checkbox" checked={allDay} onChange={(e) => toggleAllDay(e.target.checked)} /> All day
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={online}
              onChange={(e) => {
                setOnline(e.target.checked);
                setConfirmEmpty(false);
              }}
            /> Teams meeting
          </label>
          <label className="check">
            Reminder
            <select className="select" value={reminder} onChange={(e) => setReminder(Number(e.target.value))}>
              {[0, 5, 10, 15, 30, 60, 1440].map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'At start' : m === 1440 ? '1 day before' : `${m} min before`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label htmlFor="ev-location">Location</label>
          <input id="ev-location" className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room or address" />
        </div>
        <div className="form-row">
          <span className="form-label">Description</span>
          <div className="input" style={{ minHeight: 80, padding: 0 }}>
            <RichEditor label="Description" className="draft-editor" html={body} onChange={setBody} placeholder="Add a description" />
          </div>
        </div>
        {error && <span className="error-text">{error}</span>}
      </div>
    </Modal>
  );
}
