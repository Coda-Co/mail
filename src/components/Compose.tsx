import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ExternalLink, Paperclip, X } from 'lucide-react';
import { api, EVENTS, onEvent } from '../api';
import type { Draft, Message } from '../api/types';
import { AccountPicker } from './AccountPicker';
import { AddressField } from './AddressField';
import { RichEditor, type RichEditorHandle } from './RichEditor';
import { useToast } from './ui';
import { useCommand } from '../lib/commands';
import { MessageBody } from './MessageBody';
import { FileIcon } from './FileIcon';
import { keyLabel, isMac } from '../lib/platform';
import { matches } from '../lib/shortcuts';
import { formatSize } from '../lib/text';
import { fullTime } from '../lib/dates';
import { useApp } from '../state/app';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** Local editing state for a draft, autosaved to the core (and from there to the server's Drafts). */
export function useDraft(initial: Draft) {
  const [draft, setDraft] = useState(initial);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const latest = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  // Changed in this window, saved or not.
  const touched = useRef(false);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return latest.current;
    dirty.current = false;
    setSaveState('saving');
    try {
      const saved = await api.updateDraft(latest.current);
      if (!dirty.current) {
        // Keep local text; take server-side fields.
        latest.current = { ...latest.current, savedToServer: saved.savedToServer, updatedAt: saved.updatedAt };
        setDraft(latest.current);
        setSaveState('saved');
      }
      return latest.current;
    } catch {
      dirty.current = true;
      setSaveState('error');
      return latest.current;
    }
  }, []);

  const update = useCallback(
    (patch: Partial<Draft>) => {
      latest.current = { ...latest.current, ...patch };
      setDraft(latest.current);
      dirty.current = true;
      touched.current = true;
      setSaveState('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(save, 800);
    },
    [save],
  );

  const replace = useCallback((d: Draft) => {
    latest.current = d;
    setDraft(d);
  }, []);

  // Pick up edits made in another window (pop-out) while we're not editing.
  useEffect(
    () =>
      onEvent<{ draftId: string }>(EVENTS.draftChanged, ({ draftId }) => {
        if (draftId !== initial.id || dirty.current) return;
        api.getDraft(draftId).then(replace).catch(() => {});
      }),
    [initial.id, replace],
  );

  // Save on unmount.
  useEffect(
    () => () => {
      if (dirty.current) api.updateDraft(latest.current).catch(() => {});
    },
    [],
  );

  return { draft, update, replace, save, saveState, touched };
}

export type ComposeLayout = 'inline' | 'popout';

const MODE_TITLE: Record<Draft['mode'], string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' };

interface Props {
  initial: Draft;
  layout: ComposeLayout;
  /** Called after send, discard, pop-out, or close (Escape: saved, kept in Drafts). */
  onDone: (outcome: 'sent' | 'discarded' | 'poppedOut' | 'closed') => void;
  autoFocus?: boolean;
}

export function Compose({ initial, layout, onDone, autoFocus }: Props) {
  const { draft, update, replace, save, saveState, touched } = useDraft(initial);
  const toast = useToast();
  const { sync } = useApp();
  const editor = useRef<RichEditorHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [sending, setSending] = useState(false);
  // A held or failed send shows why on the card.
  const [error, setError] = useState<string | null>(
    initial.status === 'unknown' || initial.status === 'failed' ? (initial.error ?? null) : null,
  );
  const [source, setSource] = useState<Message | null>(null);
  const isNewLike = draft.mode === 'new' || draft.mode === 'forward';

  useEffect(() => {
    if (layout === 'popout' && draft.sourceMessageId && draft.mode !== 'forward') api.getMessage(draft.sourceMessageId).then(setSource).catch(() => {});
  }, [layout, draft.sourceMessageId, draft.mode]);

  useEffect(() => {
    if (autoFocus && draft.to.length > 0) setTimeout(() => editor.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    if (sending) return;
    setError(null);
    setSending(true);
    try {
      await save();
      const result = await api.sendDraft(draft.id);
      // Sending goes through the outbox: online it leaves within seconds, offline on reconnect.
      if (result.status === 'queued' || result.status === 'sending')
        toast(sync.online ? 'Sending…' : 'Queued. It will send when you’re back online.');
      else if (result.status === 'unknown') toast('Held: it may not have sent. Check Sent before trying again.');
      else if (result.status === 'failed') throw new Error(result.error ?? 'Sending failed.');
      else toast('Sent');
      onDone('sent');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    await api.discardDraft(draft.id);
    onDone('discarded');
  };

  // Escape closes the draft, like closing a compose window in Outlook: a
  // reply nobody has changed is discarded, anything else is saved. A pop-out
  // window always takes it; an inline draft only while focus is inside it,
  // so Escape elsewhere in the thread works as before.
  useCommand('escape', () => {
    if (layout === 'inline' && !root.current?.contains(document.activeElement)) return false;
    const untouchedReply = (draft.mode === 'reply' || draft.mode === 'replyAll') && draft.edited === false && !touched.current;
    if (untouchedReply) void discard();
    else void save().then(() => onDone('closed'));
  });

  const popOut = async () => {
    await save();
    await api.popOut('draft', draft.id);
    onDone('poppedOut');
  };

  const dockBack = async () => {
    await save();
    await api.dockBack(draft.id);
  };

  const attach = async () => {
    await save();
    replace(await api.addAttachment(draft.id));
  };

  const removeAttachment = async (id: string) => {
    await save();
    replace(await api.removeAttachment(draft.id, id));
  };

  const changeAccount = async (accountId: string) => {
    await save();
    replace(await api.changeDraftAccount(draft.id, accountId));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (matches(e, 'Mod+Enter', isMac)) {
      e.preventDefault();
      e.stopPropagation();
      send();
    }
  };

  const saveLabel = saveState === 'saved' ? 'Draft saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : '';

  const fromRow = (
    <div className="field-row">
      <span className="field-label">From</span>
      <AccountPicker accountId={draft.accountId} onChange={changeAccount} />
    </div>
  );
  const toRow = (
    <div className="field-row">
      <span className="field-label">To</span>
      <AddressField label="To" value={draft.to} onChange={(to) => update({ to })} autoFocus={autoFocus && draft.to.length === 0} />
      {(!showCc || !showBcc) && (
        <span className="cc-toggles">
          {!showCc && (
            <button type="button" onClick={() => setShowCc(true)}>
              Cc
            </button>
          )}
          {!showBcc && (
            <button type="button" onClick={() => setShowBcc(true)}>
              Bcc
            </button>
          )}
        </span>
      )}
    </div>
  );
  const ccRow = showCc && (
    <div className="field-row">
      <span className="field-label">Cc</span>
      <AddressField label="Cc" value={draft.cc} onChange={(cc) => update({ cc })} />
    </div>
  );
  const bccRow = showBcc && (
    <div className="field-row">
      <span className="field-label">Bcc</span>
      <AddressField label="Bcc" value={draft.bcc} onChange={(bcc) => update({ bcc })} />
    </div>
  );
  const subjectRow = (isNewLike || layout === 'popout') && (
    <div className="field-row">
      <span className="field-label">Subject</span>
      <input className="plain" aria-label="Subject" value={draft.subject} onChange={(e) => update({ subject: e.target.value })} />
    </div>
  );
  const body = (
    <RichEditor
      ref={editor}
      className="draft-editor"
      label="Message text"
      html={draft.bodyHtml}
      onChange={(bodyHtml) => update({ bodyHtml })}
      placeholder={draft.mode === 'new' ? 'Write your message…' : 'Write your reply…'}
    />
  );
  const attachments = draft.attachments.length > 0 && (
    <div className="attachments draft-attachments">
      {draft.attachments.map((a) => (
        <span key={a.id} className="attachment-chip">
          <FileIcon name={a.name} contentType={a.contentType} />
          <span className="name">{a.name}</span>
          <span className="size">{formatSize(a.size)}</span>
          <button type="button" className="remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>
            <X size={14} />
          </button>
        </span>
      ))}
    </div>
  );

  if (layout === 'popout') {
    return (
      <div className="popout" ref={root} onKeyDown={onKeyDown}>
        <div className="popout-toolbar">
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending}>
            Send
          </button>
          <span className="kbd-hint">{keyLabel('Mod+Enter')}</span>
          <span className="spacer" />
          <span className="kbd-hint">{saveLabel}</span>
          <button type="button" className="btn btn-ghost" onClick={attach}>
            <Paperclip size={15} />
            Attach
          </button>
          <button type="button" className="btn btn-ghost" onClick={dockBack}>
            Dock back
          </button>
          <button type="button" className="btn btn-ghost" onClick={discard}>
            Discard
          </button>
        </div>
        {error && <div className="draft-error">{error}</div>}
        {fromRow}
        {toRow}
        {ccRow}
        {bccRow}
        {subjectRow}
        <div className="popout-body">
          {body}
          {attachments}
          {source && (
            <div className="quoted">
              <span className="meta">
                {source.from.name || source.from.email} · {fullTime(source.receivedAt)}
              </span>
              <MessageBody html={source.bodyHtml} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="draft-section" ref={root} aria-label={`${MODE_TITLE[draft.mode]} draft`} onKeyDown={onKeyDown}>
      <div className="draft-section-header">
        <span className="title">{MODE_TITLE[draft.mode]}</span>
        <button type="button" className="btn btn-ghost" onClick={popOut}>
          <ExternalLink size={14} />
          Pop out
        </button>
        <button type="button" className="btn btn-ghost" onClick={discard}>
          Discard
        </button>
      </div>
      {fromRow}
      {toRow}
      {ccRow}
      {bccRow}
      {subjectRow}
      {body}
      {attachments}
      {error && <div className="draft-error">{error}</div>}
      <div className="draft-footer">
        <button type="button" className="btn btn-primary" onClick={send} disabled={sending}>
          Send
        </button>
        <span className="kbd-hint">{keyLabel('Mod+Enter')}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Attach a file" onClick={attach}>
          <Paperclip size={16} />
        </button>
        <span className="kbd-hint">{saveLabel}</span>
      </div>
    </div>
  );
}

/** Shown in place of a draft that's open in its own window. */
export function PoppedOutDraft({ draft }: { draft: Draft }) {
  return (
    <div className="draft-section">
      <div className="draft-popped">
        <ExternalLink size={14} />
        <span style={{ flex: 1 }}>{MODE_TITLE[draft.mode]} is open in its own window.</span>
        <button type="button" className="btn btn-small" onClick={() => api.dockBack(draft.id)}>
          Dock back
        </button>
      </div>
    </div>
  );
}

/** Shown in place of an inline draft closed with Escape; the draft stays saved. */
export function ClosedDraft({ draft, onOpen }: { draft: Draft; onOpen: () => void }) {
  return (
    <div className="draft-section">
      <div className="draft-popped">
        <span style={{ flex: 1 }}>{MODE_TITLE[draft.mode]} draft saved.</span>
        <button type="button" className="btn btn-small" onClick={onOpen}>
          Continue editing
        </button>
      </div>
    </div>
  );
}
