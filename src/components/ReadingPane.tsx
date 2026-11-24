import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, MoreHorizontal } from 'lucide-react';
import { api, EVENTS, onEvent } from '../api';
import type { Draft, DraftMode, Folder, Message, Thread } from '../api/types';
import { useApp } from '../state/app';
import { useCommand } from '../lib/commands';
import { fullTime } from '../lib/dates';
import { formatSize } from '../lib/text';
import { Avatar, Menu, useToast, type Anchor, type MenuItem } from './ui';
import { MessageBody } from './MessageBody';
import { splitQuoted } from '../lib/quoted';
import { FileIcon } from './FileIcon';
import { Compose, PoppedOutDraft } from './Compose';

export type Selection = { kind: 'message' | 'draft'; id: string };

function recipients(m: Message, meName: string, myEmails: string[]): string {
  const names = m.to.map((a) => (myEmails.includes(a.email.toLowerCase()) ? meName : a.name || a.email));
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function MessageView({
  message,
  expanded,
  onExpand,
  onCollapse,
  onChanged,
}: {
  message: Message;
  expanded: boolean;
  onExpand: () => void;
  /** Set for messages that can fold back to one line (not the one that was opened). */
  onCollapse?: () => void;
  onChanged: (m: Message) => void;
}) {
  const { accountById, me, accounts, settings } = useApp();
  const acc = accountById(message.accountId);
  const myEmails = accounts.map((a) => a.email.toLowerCase());
  const split = useMemo(() => splitQuoted(message.bodyHtml), [message.bodyHtml]);
  const [showQuoted, setShowQuoted] = useState(false);
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
      <div
        className={onCollapse ? 'message-head collapsible' : 'message-head'}
        {...(onCollapse && {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': true,
          title: 'Collapse',
          onClick: (e: React.MouseEvent) => {
            // Leave selecting text in the header alone.
            if (!window.getSelection()?.isCollapsed) return;
            if ((e.target as Element).closest('a, button')) return;
            onCollapse();
          },
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            onCollapse();
          },
        })}
      >
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
          {/* With images on, only Junk blocks them. */}
          <span>{settings.remoteImages === 'ask' ? 'Remote images blocked' : 'Images are hidden in Junk'}</span>
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
                <FileIcon name={a.name} contentType={a.contentType} />
                <span className="name">{a.name}</span>
                <span className="size">{formatSize(a.size)}</span>
              </button>
            ))}
        </div>
      )}
      <MessageBody html={showQuoted ? message.bodyHtml : split.main} cacheKey={showQuoted || !split.hasQuote ? message.id : `${message.id}:new`} />
      {split.hasQuote && (
        <button
          type="button"
          className="quote-toggle"
          aria-expanded={showQuoted}
          title={showQuoted ? 'Hide quoted text' : 'Show quoted text'}
          onClick={() => setShowQuoted((v) => !v)}
        >
          {showQuoted ? 'Hide quoted text' : '•••'}
        </button>
      )}
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
  // The message the loaded thread was opened for: shown expanded, earlier messages collapsed below.
  const [shownId, setShownId] = useState<string | null>(null);
  const [showLater, setShowLater] = useState(false);

  // While the next message loads, the previous thread stays on screen (no blank flash),
  // but actions only target a thread that holds the selected message.
  const current = !!thread && selection?.kind === 'message' && thread.messages.some((m) => m.id === selection.id);
  const selectedMessage = current ? (thread.messages.find((m) => m.id === selection?.id) ?? null) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const latest = useRef(0);
  const shownConversation = useRef<string | null>(null);
  const shownMessage = useRef<string | null>(null);
  const wanted = useRef<string | null>(null);

  const loadThread = useCallback(async (id: string) => {
    const req = ++latest.current;
    try {
      const t = await api.getThread(id);
      // A slower reply for an earlier click, or a refresh of a thread the user has since
      // left, must not replace what they are now looking at.
      if (req !== latest.current || (wanted.current && !t.messages.some((m) => m.id === wanted.current))) return null;
      // Opening another message (even in the same conversation) starts fresh; a refresh keeps state.
      if (shownConversation.current !== t.conversationId || shownMessage.current !== id) {
        shownConversation.current = t.conversationId;
        shownMessage.current = id;
        setExpanded(new Set([id]));
        setShowLater(false);
        scrollRef.current?.scrollTo(0, 0);
      }
      setThread(t);
      setShownId(id);
      setError(null);
      return t;
    } catch (e) {
      if (req !== latest.current) return null;
      setError(e instanceof Error ? e.message : String(e));
      shownConversation.current = null;
      setThread(null);
      return null;
    }
  }, []);

  useEffect(() => {
    setDraft(null);
    setFocusDraft(false);
    wanted.current = selection?.kind === 'message' ? selection.id : null;
    if (!selection || selection.kind === 'draft') {
      latest.current++;
      shownConversation.current = null;
      setThread(null);
    }
    if (!selection) return;
    if (selection.kind === 'draft') {
      api.getDraft(selection.id).then(setDraft).catch((e) => setError(String(e)));
      return;
    }
    setExpanded((s) => new Set(s).add(selection.id));
    // Mark as read as soon as it opens, but only once the user can actually see it: a message
    // selected while the app is in the background (e.g. new mail auto-selected) stays unread
    // until the window is focused, and is left alone if the selection moves on first.
    let cancelled = false;
    let stopWaiting: (() => void) | null = null;
    loadThread(selection.id).then((t) => {
      if (cancelled) return;
      const m = t?.messages.find((x) => x.id === selection.id);
      if (!m || m.isRead) return;
      const mark = () => void api.markRead([m.id], true);
      if (document.hasFocus()) return mark();
      const onFocus = () => {
        stopWaiting?.();
        mark();
      };
      window.addEventListener('focus', onFocus);
      stopWaiting = () => window.removeEventListener('focus', onFocus);
    });
    return () => {
      cancelled = true;
      stopWaiting?.();
    };
  }, [selection, loadThread]);

  // Attachments (and inline images) arrive in the background after the thread opens and are
  // announced with mail://changed; refresh quietly so they appear without reopening.
  const seenMailVersion = useRef(app.mailVersion);
  useEffect(() => {
    if (seenMailVersion.current === app.mailVersion) return;
    seenMailVersion.current = app.mailVersion;
    if (selection?.kind !== 'message') return;
    const id = selection.id;
    api
      .getThread(id)
      .then((t) => setThread((cur) => (cur && cur.messages.some((m) => m.id === id) ? t : cur)))
      .catch(() => {});
  }, [app.mailVersion, selection]);

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
    'markUnread',
    () => {
      if (!selectedMessage) return;
      const id = selectedMessage.id;
      void api.markRead([id], false).then(() => {
        loadThread(id);
        toast('Marked as unread');
      });
    },
    hasMessage,
  );
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
        <button type="button" className="btn btn-ghost" onClick={() => startDraft('reply')} disabled={!thread}>
          Reply
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => startDraft('replyAll')} disabled={!thread}>
          Reply all
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => startDraft('forward')} disabled={!thread}>
          Forward
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={() => removeWithUndo('archive')} disabled={!thread}>
          Archive
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => removeWithUndo('delete')} disabled={!thread}>
          Delete
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="More actions" onClick={(e) => moreMenu(e.currentTarget)} disabled={!thread}>
          <MoreHorizontal size={16} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Open in new window" onClick={() => selectedMessage && api.popOut('message', selectedMessage.id)} disabled={!thread}>
          <ExternalLink size={15} />
        </button>
      </div>
      <div className="reading-scroll" ref={scrollRef}>
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
            {(() => {
              // Newest first: messages before the opened one are later replies, after it are earlier ones.
              const at = Math.max(0, thread.messages.findIndex((m) => m.id === shownId));
              const later = thread.messages.slice(0, at);
              const shown = showLater ? thread.messages : thread.messages.slice(at);
              return (
                <>
                  {later.length > 0 && (
                    <button type="button" className="link-button later-toggle" onClick={() => setShowLater((v) => !v)}>
                      {showLater ? 'Hide later messages' : `Show ${later.length} later ${later.length === 1 ? 'message' : 'messages'}`}
                    </button>
                  )}
                  {shown.map((m) => (
                    <MessageView
                      key={m.id}
                      message={m}
                      expanded={m.id === shownId || expanded.has(m.id)}
                      onExpand={() => setExpanded((s) => new Set(s).add(m.id))}
                      onCollapse={
                        m.id === shownId
                          ? undefined
                          : () =>
                              setExpanded((s) => {
                                const next = new Set(s);
                                next.delete(m.id);
                                return next;
                              })
                      }
                      onChanged={(updated) => setThread((t) => (t ? { ...t, messages: t.messages.map((x) => (x.id === updated.id ? updated : x)) } : t))}
                    />
                  ))}
                </>
              );
            })()}
          </div>
        )}
      </div>
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} align="end" />}
    </article>
  );
}
