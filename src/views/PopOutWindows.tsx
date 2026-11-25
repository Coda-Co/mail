import { useEffect, useState } from 'react';
import { api, EVENTS, onEvent } from '../api';
import type { Draft, Message } from '../api/types';
import { Compose } from '../components/Compose';
import { MessageBody } from '../components/MessageBody';
import { AttachmentList } from '../components/ReadingPane';
import { useToast } from '../components/ui';
import { useApp } from '../state/app';
import { fullTime } from '../lib/dates';
import { useCommand } from '../lib/commands';
import { isTauri } from '../api';

async function closeWindow() {
  if (isTauri) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  } else {
    window.close();
  }
}

/** A draft in its own window (#/compose/<id>). */
export function ComposeWindow({ draftId }: { draftId: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    api.getDraft(draftId).then((d) => {
      setDraft(d);
      document.title = d.subject || 'New message';
    }).catch(() => setGone(true));
  }, [draftId]);

  // Docked back or sent from the main window: close this one.
  useEffect(
    () =>
      onEvent<{ draftId: string }>(EVENTS.draftDocked, ({ draftId: id }) => {
        if (id !== draftId) return;
        api.getDraft(draftId).then((d) => {
          if (!d.poppedOut) closeWindow();
        }).catch(() => closeWindow());
      }),
    [draftId],
  );

  if (gone) return <div className="empty-state"><span className="body">This draft was sent or discarded.</span></div>;
  if (!draft) return null;
  return (
    <Compose
      initial={draft}
      layout="popout"
      autoFocus
      onDone={(outcome) => {
        // Escape: hand the saved draft back to the main window, which closes this one.
        if (outcome === 'closed') api.dockBack(draftId).catch(() => closeWindow());
        else if (outcome !== 'poppedOut') closeWindow();
      }}
    />
  );
}

/** A message in its own window (#/message/<id>). */
export function MessageWindow({ messageId }: { messageId: string }) {
  const { accountById, mailVersion } = useApp();
  const toast = useToast();
  const [message, setMessage] = useState<Message | null>(null);
  useCommand('escape', () => void closeWindow());
  // Reload when mail changes too: attachments can arrive after the window opens.
  useEffect(() => {
    api
      .getMessage(messageId)
      .then((m) => {
        setMessage(m);
        document.title = m.subject;
      })
      .catch(() => {});
  }, [messageId, mailVersion]);
  if (!message) return null;
  const acc = accountById(message.accountId);
  const reply = async (mode: 'reply' | 'replyAll' | 'forward') => {
    const d = await api.createDraft({ mode, sourceMessageId: message.id });
    await api.popOut('draft', d.id);
  };
  return (
    <div className="popout popout-message">
      <div className="popout-toolbar">
        <button type="button" className="btn btn-ghost" onClick={() => reply('reply')}>Reply</button>
        <button type="button" className="btn btn-ghost" onClick={() => reply('replyAll')}>Reply all</button>
        <button type="button" className="btn btn-ghost" onClick={() => reply('forward')}>Forward</button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={async () => {
            await api.archive([message.id]);
            toast('Archived');
            closeWindow();
          }}
        >
          Archive
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={async () => {
            await api.deleteMessages([message.id]);
            closeWindow();
          }}
        >
          Delete
        </button>
      </div>
      <div className="reading-scroll">
        <div className="reading-content">
          <h2 className="thread-subject">{message.subject}</h2>
          <div className="message-block">
            <div className="message-head">
              <div className="who">
                <span className="name">{message.from.name || message.from.email}</span>
                <span className="meta">To {message.to.map((a) => a.name || a.email).join(', ')} · {fullTime(message.receivedAt)}</span>
              </div>
              {acc && (
                <span className="acc-chip">
                  <span className="acc-dot" style={{ background: acc.color }} />
                  {acc.displayName}
                </span>
              )}
            </div>
            <AttachmentList message={message} />
            <MessageBody html={message.bodyHtml} />
          </div>
        </div>
      </div>
    </div>
  );
}
