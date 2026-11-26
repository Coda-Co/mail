import { useEffect, useState } from 'react';
import { AlertTriangle, ClockArrowUp, LoaderCircle, Paperclip } from 'lucide-react';
import { api, EVENTS, onEvent } from '../api';
import type { Draft } from '../api/types';
import { useApp } from '../state/app';
import { MessageBody } from './MessageBody';
import { useToast } from './ui';

/** Sent but not yet gone: queued, going out now, or held. */
export function inOutbox(d: Draft): boolean {
  return d.status === 'queued' || d.status === 'sending' || d.status === 'unknown';
}

const names = (list: Draft['to']) => list.map((a) => a.name || a.email).join(', ');

/**
 * A message in the Outbox, read-only: where it's up to, and Edit to take it back to Drafts
 * (it then won't be sent). A held send — we couldn't confirm it went — can also be sent again.
 */
export function OutboxItem({ initial, onGone, onEdit }: { initial: Draft; onGone: () => void; onEdit: (d: Draft) => void }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const { sync } = useApp();
  const toast = useToast();

  // Follow it as it goes out; once sent it no longer exists. Back to a draft (taken back to edit,
  // or the send failed): open it to edit.
  useEffect(
    () =>
      onEvent<{ draftId: string }>(EVENTS.draftChanged, ({ draftId }) => {
        if (draftId !== initial.id) return;
        api
          .getDraft(draftId)
          .then((d) => (inOutbox(d) ? setDraft(d) : onEdit(d)))
          .catch(() => onGone());
      }),
    [initial.id, onGone, onEdit],
  );
  useEffect(
    () =>
      onEvent<{ draftId: string }>(EVENTS.draftDocked, ({ draftId }) => {
        if (draftId === initial.id) onGone();
      }),
    [initial.id, onGone],
  );

  const edit = async () => {
    setBusy(true);
    try {
      const d = await api.cancelSend(draft.id);
      toast('Moved back to Drafts. It won’t be sent.');
      onEdit(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const sendAgain = async () => {
    setBusy(true);
    try {
      setDraft(await api.sendDraft(draft.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const held = draft.status === 'unknown';
  const going = draft.status === 'sending';
  const status = held
    ? (draft.error ?? 'We couldn’t confirm this was sent. Check Sent before sending again.')
    : going
      ? 'Sending now…'
      : sync.online
        ? 'Waiting to send. It will go in a moment.'
        : 'Waiting to send. It will go when you’re back online.';

  return (
    <section className={`outbox-item${held ? ' held' : ''}`} aria-label="Outbox message">
      <div className="outbox-status" role="status">
        {held ? <AlertTriangle size={16} /> : going ? <LoaderCircle size={16} className="spin" /> : <ClockArrowUp size={16} />}
        <span className="text">{status}</span>
        {held && (
          <button type="button" className="btn btn-small" onClick={sendAgain} disabled={busy}>
            Send again
          </button>
        )}
        {!going && (
          <button type="button" className="btn btn-small" onClick={edit} disabled={busy} title="Stop sending and move it back to Drafts">
            Edit
          </button>
        )}
      </div>
      <div className="outbox-head">
        <div>
          <span className="label">To</span> {names(draft.to) || '—'}
        </div>
        {draft.cc.length > 0 && (
          <div>
            <span className="label">Cc</span> {names(draft.cc)}
          </div>
        )}
        {draft.bcc.length > 0 && (
          <div>
            <span className="label">Bcc</span> {names(draft.bcc)}
          </div>
        )}
        {draft.attachments.length > 0 && (
          <div className="outbox-attachments">
            <Paperclip size={13} /> {draft.attachments.map((a) => a.name).join(', ')}
          </div>
        )}
      </div>
      <MessageBody html={draft.bodyHtml} />
    </section>
  );
}
