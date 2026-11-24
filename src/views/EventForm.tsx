import { useState } from 'react';
import { api } from '../api';
import type { Address, CalendarEvent, EventInput } from '../api/types';
import { useApp } from '../state/app';
import { Modal } from '../components/ui';
import { AddressField } from '../components/AddressField';
import { RichEditor } from '../components/RichEditor';
import { addDays, startOfDay, toDateInput, toLocalInput } from '../lib/dates';
import { now } from '../lib/clock';

function defaultStart(): Date {
  const n = now();
  const d = new Date(n);
  d.setMinutes(n.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

export function EventForm({ event, start, onClose, onSaved }: { event?: CalendarEvent; start?: Date; onClose: () => void; onSaved: (e: CalendarEvent) => void }) {
  const { graphAccounts } = useApp();
  const s0 = event ? new Date(event.start) : (start ?? defaultStart());
  const e0 = event ? new Date(event.end) : new Date(s0.getTime() + 30 * 60000);
  const [accountId, setAccountId] = useState(event?.accountId ?? graphAccounts[0]?.id ?? '');
  const [subject, setSubject] = useState(event?.subject ?? '');
  const [allDay, setAllDay] = useState(event?.isAllDay ?? false);
  const [startText, setStartText] = useState(allDay ? toDateInput(s0) : toLocalInput(s0));
  const [endText, setEndText] = useState(allDay ? toDateInput(addDays(e0, -1)) : toLocalInput(e0));
  const [location, setLocation] = useState(event?.location ?? '');
  const [attendees, setAttendees] = useState<Address[]>(event?.attendees.filter((a) => a.response !== 'organizer').map((a) => a.address) ?? []);
  const [online, setOnline] = useState(event?.isOnlineMeeting ?? false);
  const [reminder, setReminder] = useState(event?.reminderMinutes ?? 15);
  const [body, setBody] = useState(event?.bodyHtml ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleAllDay = (v: boolean) => {
    setAllDay(v);
    const s = new Date(startText);
    const e = new Date(endText);
    setStartText(v ? toDateInput(s) : toLocalInput(new Date(startOfDay(s).getTime() + 9 * 3600000)));
    setEndText(v ? toDateInput(e) : toLocalInput(new Date(startOfDay(s).getTime() + 9.5 * 3600000)));
  };

  const save = async () => {
    setError(null);
    let start: Date;
    let end: Date;
    if (allDay) {
      start = new Date(`${startText}T00:00`);
      end = addDays(new Date(`${endText}T00:00`), 1);
    } else {
      start = new Date(startText);
      end = new Date(endText);
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return setError('Check the start and end times.');
    if (end <= start) return setError('The end must be after the start.');
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
            {attendees.length > 0 && !event ? 'Send' : 'Save'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="form-row">
          <label htmlFor="ev-title">Title</label>
          <input id="ev-title" className="input" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Add a title" />
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
        <div className="form-inline">
          <div className="form-row" style={{ flex: 1 }}>
            <label htmlFor="ev-start">Starts</label>
            <input id="ev-start" className="input" type={allDay ? 'date' : 'datetime-local'} value={startText} onChange={(e) => setStartText(e.target.value)} />
          </div>
          <div className="form-row" style={{ flex: 1 }}>
            <label htmlFor="ev-end">Ends</label>
            <input id="ev-end" className="input" type={allDay ? 'date' : 'datetime-local'} value={endText} onChange={(e) => setEndText(e.target.value)} />
          </div>
        </div>
        <div className="form-inline">
          <label className="check">
            <input type="checkbox" checked={allDay} onChange={(e) => toggleAllDay(e.target.checked)} /> All day
          </label>
          <label className="check">
            <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> Teams meeting
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
          <span className="form-label">Attendees</span>
          <div className="input" style={{ display: 'flex' }}>
            <AddressField label="Attendees" value={attendees} onChange={setAttendees} />
          </div>
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
