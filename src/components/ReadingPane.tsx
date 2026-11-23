import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, FileText, MoreHorizontal } from 'lucide-react';
import { api, EVENTS, onEvent } from '../api';
import type { Draft, DraftMode, Folder, Message, Thread } from '../api/types';
import { useApp } from '../state/app';
import { useCommand } from '../lib/commands';
import { fullTime } from '../lib/dates';
import { formatSize } from '../lib/text';
import { Avatar, Menu, useToast, type Anchor, type MenuItem } from './ui';
import { MessageBody } from './MessageBody';
import { Compose, PoppedOutDraft } from './Compose';

export type Selection = { kind: 'message' | 'draft'; id: string };

function recipients(m: Message, meName: string, myEmails: string[]): string {
  const names = m.to.map((a) => (myEmails.includes(a.email.toLowerCase()) ? meName : a.name || a.email));
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function MessageView({ message, expanded, onExpand, onChanged }: { message: Message; expanded: boolean; onExpand: () => void; onChanged: (m: Message) => void }) {
  const { accountById, me, accounts } = useApp();
  const acc = accountById(message.accountId);
  const myEmails = accounts.map((a) => a.email.toLowerCase());
  if (!expanded) {
    return (
      <div className="message-block">
        <button type="button" className="collapsed-message" onClick={onExpand}>
          <b style={{ color: 'var(--text)', fontWeight: 600 }}>{message.from.name || message.from.email}</b> · {fullTime(message.receivedAt)} · {message.snippet}
        </button>
      </div>
    );
  }
  return (
    <div className="message-block">
      <div className="message-head">
        <Avatar name={message.from.name || message.from.email} />
        <div className="who">
          <span className="name" title={message.from.email}>
            {message.from.name || message.from.email}
          </span>
          <span className="meta">
            To {recipients(message, me.name, myEmails)}
            {message.cc.length > 0 && `, cc ${message.cc.map((a) => a.name || a.email).join(', ')}`} · {fullTime(message.receivedAt)}
          </span>
        </div>
        {acc && (
          <span className="acc-chip">
            <span className="acc-dot" style={{ background: acc.color }} />
            {acc.displayName}
          </span>
        )}
      </div>
      {message.remoteImagesBlocked && (
        <div className="images-bar">
          <span>Remote images blocked</span>
          <button type="button" className="link-button" onClick={async () => onChanged(await api.showRemoteImagesOnce(message.id))}>
            Show images
          </button>
          <button
            type="button"
            className="link-button"
            onClick={async () => {
              await api.allowRemoteImages(message.from.email);
              onChanged(await api.showRemoteImagesOnce(message.id));
            }}
          >
            Always show from {message.from.name || message.from.email}
          </button>
        </div>
      )}
      {message.attachments.filter((a) => !a.isInline).length > 0 && (
        <div className="attachments">
          {message.attachments
            .filter((a) => !a.isInline)
            .map((a) => (
              <button key={a.id} type="button" className="attachment-chip" onClick={() => api.openAttachment(message.id, a.id)} title={`Open ${a.name}`}>
                <FileText size={14} />
                <span className="name">{a.name}</span>
                <span className="size">{formatSize(a.size)}</span>
              </button>
            ))}
        </div>
      )}
      <MessageBody html={message.bodyHtml} />
    </div>
  );
}

export function ReadingPane({ selection, onBack, onRemoved }: { selection: Selection | null; onBack: () => void; onRemoved: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [thread, setThread] = useState<Thread | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusDraft, setFocusDraft] = useState(false);
  const [menu, setMenu] = useState<{ anchor: Anchor; items: MenuItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedMessage = thread?.messages.find((m) => m.id === selection?.id) ?? thread?.messages[0] ?? null;

  const loadThread = useCallback(async (id: string) => {
    try {
      const t = await api.getThread(id);
      setThread(t);
      setError(null);
      return t;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setThread(null);
      return null;
    }
  }, []);

  useEffect(() => {
    setThread(null);
    setDraft(null);
    setFocusDraft(false);
    if (!selection) return;
    if (selection.kind === 'draft') {
      api.getDraft(selection.id).then(setDraft).catch((e) => setError(String(e)));
      return;
    }
    setExpanded(new Set([selection.id]));
    // Mark as read after it has been open briefly, so skimming past doesn't.
    let timer: ReturnType<typeof setTimeout> | undefined;
    loadThread(selection.id).then((t) => {
      const m = t?.messages.find((x) => x.id === selection.id);
      if (m && !m.isRead) timer = setTimeout(() => api.markRead([m.id], true), 1500);
    });
    return () => clearTimeout(timer);
  }, [selection, loadThread]);

  useEffect(
    () =>
      onEvent(EVENTS.draftDocked, () => {
        if (selection?.kind === 'message') loadThread(selection.id);
      }),
    [selection, loadThread],
  );

  const startDraft = async (mode: DraftMode) => {
    if (!selectedMessage) return;
    const open = thread?.drafts.find((d) => !d.poppedOut);
    if (open) {
      setFocusDraft(true);
      return;
    }
    await api.createDraft({ mode, sourceMessageId: selectedMessage.id });
    setFocusDraft(true);
    await loadThread(selectedMessage.id);
  };

  const removeWithUndo = async (kind: 'archive' | 'delete') => {
    if (!selectedMessage) return;
    const ids = [selectedMessage.id];
    const original = selectedMessage.folderId;
    if (kind === 'archive') await api.archive(ids);
    else await api.deleteMessages(ids);
    onRemoved();
    toast(kind === 'archive' ? 'Archived' : 'Deleted', { label: 'Undo', run: () => api.moveMessages(ids, original) });
  };

  const hasMessage = selection?.kind === 'message' && !!selectedMessage && !app.settingsTab;
  useCommand('reply', () => void startDraft('reply'), hasMessage);
  useCommand('replyAll', () => void startDraft('replyAll'), hasMessage);
  useCommand('archive', () => void removeWithUndo('archive'), hasMessage);
  useCommand('delete', () => void removeWithUndo('delete'), hasMessage);
  useCommand(
    'ctrlF',
    () => {
      if (app.settings.ctrlF !== 'forward') return false;
      void startDraft('forward');
    },
    hasMessage,
  );

  const moreMenu = async (anchor: HTMLElement) => {
    if (!selectedMessage) return;
    const m = selectedMessage;
    const folders: Folder[] = await api.listFolders(m.accountId);
    const items: MenuItem[] = [
      { label: m.isRead ? 'Mark as unread' : 'Mark as read', onSelect: async () => {
        await api.markRead([m.id], !m.isRead);
        loadThread(m.id);
      } },
      { label: m.isFlagged ? 'Unflag' : 'Flag', onSelect: async () => {
        await api.setFlag([m.id], !m.isFlagged);
        loadThread(m.id);
      } },
      ...folders
        .filter((f) => f.id !== m.folderId && f.role !== 'drafts')
        .map((f, i) => ({
          label: `Move to ${f.name}`,
          separatorBefore: i === 0,
          onSelect: async () => {
            await api.moveMessages([m.id], f.id);
            onRemoved();
            toast(`Moved to ${f.name}`, { label: 'Undo', run: () => api.moveMessages([m.id], m.folderId) });
          },
        })),
    ];
    setMenu({ anchor, items });
  };

  if (!selection) {
    return (
      <article className="reading-pane" aria-label="Reading pane">
        <div className="empty-state">
          <span className="body">Select a message to read it.</span>
        </div>
      </article>
    );
  }

  if (selection.kind === 'draft') {
    return (
      <article className="reading-pane" aria-label="Compose">
        <div className="reading-toolbar">
          <button type="button" className="btn btn-ghost back-button" onClick={onBack}>
            <ArrowLeft size={15} /> Back
          </button>
        </div>
        <div className="reading-scroll">
          <div className="reading-content">
            {error && <span className="error-text">{error}</span>}
            {draft &&
              (draft.poppedOut ? (
                <PoppedOutDraft draft={draft} />
              ) : (
                <Compose key={draft.id} initial={draft} layout="inline" autoFocus onDone={() => onBack()} />
              ))}
          </div>
        </div>
      </article>
    );
  }

  const inlineDraft = thread?.drafts[thread.drafts.length - 1];

  return (
    <article className="reading-pane" aria-label="Reading pane">
      <div className="reading-toolbar">
        <button type="button" className="btn btn-ghost back-button" onClick={onBack} aria-label="Back to list">
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => startDraft('reply')} disabled={!selectedMessage}>
          Reply
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => startDraft('replyAll')} disabled={!selectedMessage}>
          Reply all
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => startDraft('forward')} disabled={!selectedMessage}>
          Forward
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={() => removeWithUndo('archive')} disabled={!selectedMessage}>
          Archive
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => removeWithUndo('delete')} disabled={!selectedMessage}>
          Delete
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="More actions" onClick={(e) => moreMenu(e.currentTarget)} disabled={!selectedMessage}>
          <MoreHorizontal size={16} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Open in new window" onClick={() => selectedMessage && api.popOut('message', selectedMessage.id)} disabled={!selectedMessage}>
          <ExternalLink size={15} />
        </button>
      </div>
      <div className="reading-scroll">
        {error && (
          <div className="empty-state">
            <span className="body">This message couldn’t be loaded. {error}</span>
          </div>
        )}
        {thread && (
          <div className="reading-content">
            <h2 className="thread-subject">{thread.subject || '(no subject)'}</h2>
            {inlineDraft &&
              (inlineDraft.poppedOut ? (
                <PoppedOutDraft draft={inlineDraft} />
              ) : (
                <Compose
                  key={inlineDraft.id}
                  initial={inlineDraft}
                  layout="inline"
                  autoFocus={focusDraft}
                  onDone={() => {
                    setFocusDraft(false);
                    if (selection) loadThread(selection.id);
                  }}
                />
              ))}
            {thread.messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                expanded={i === 0 || expanded.has(m.id)}
                onExpand={() => setExpanded((s) => new Set(s).add(m.id))}
                onChanged={(updated) => setThread((t) => (t ? { ...t, messages: t.messages.map((x) => (x.id === updated.id ? updated : x)) } : t))}
              />
            ))}
          </div>
        )}
      </div>
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} align="end" />}
    </article>
  );
}
