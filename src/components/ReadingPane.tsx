import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarSearch, Copy, ExternalLink, Forward, MoreHorizontal, Reply, ReplyAll, X } from 'lucide-react';
import { api, EVENTS, onEvent } from '../api';
import type { Address, Draft, DraftMode, Folder, Message, Thread } from '../api/types';
import { useApp } from '../state/app';
import { useCommand } from '../lib/commands';
import { isMac } from '../lib/platform';
import { fullTime } from '../lib/dates';
import { formatSize } from '../lib/text';
import { Menu, useToast, type Anchor, type MenuItem } from './ui';
import { MessageBody } from './MessageBody';
import { splitQuoted } from '../lib/quoted';
import { FileIcon } from './FileIcon';
import { MeetingCard } from './MeetingCard';
import { ProposedTimes } from './ProposedTimes';
import { ClosedDraft, Compose, PoppedOutDraft } from './Compose';
import { inOutbox, OutboxItem } from './OutboxItem';

export type Selection = { kind: 'message' | 'draft'; id: string };

/**
 * A name in the message header: hover shows the address, and Ctrl/Cmd+C while hovering
 * (or with the name focused) copies it, unless some text is selected.
 */
function AddressName({ address, label, onActive, className }: { address: Address; label: string; onActive: (a: Address | null) => void; className?: string }) {
  return (
    <span
      className={className ? `addr ${className}` : 'addr'}
      tabIndex={0}
      title={address.email}
      onMouseEnter={() => onActive(address)}
      // A clicked (focused) name stays ready to copy after the pointer moves away.
      onMouseLeave={(e) => onActive(document.activeElement === e.currentTarget ? address : null)}
      onFocus={() => onActive(address)}
      onBlur={() => onActive(null)}
    >
      {label}
    </span>
  );
}

function useCopyHoveredAddress() {
  const toast = useToast();
  const [active, setActive] = useState<Address | null>(null);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c') return;
      if (!window.getSelection()?.isCollapsed) return;
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard
        .writeText(active.email)
        .then(() => toast(`Copied ${active.email}`))
        .catch(() => toast("Couldn't copy the address"));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, toast]);
  return setActive;
}

/** To, then cc and bcc; long To lists fold to two names and "N more" until clicked. */
function RecipientLine({ message, onActive }: { message: Message; onActive: (a: Address | null) => void }) {
  const { me, accounts } = useApp();
  const myEmails = accounts.map((a) => a.email.toLowerCase());
  const [all, setAll] = useState(false);
  const label = (a: Address) => (myEmails.includes(a.email.toLowerCase()) ? me.name : a.name || a.email);
  const list = (addrs: Address[]) =>
    addrs.map((a, i) => (
      <Fragment key={`${a.email}-${i}`}>
        {i > 0 && ', '}
        <AddressName address={a} label={label(a)} onActive={onActive} />
      </Fragment>
    ));
  const folded = !all && message.to.length > 2;
  return (
    <span className={all ? 'meta all' : 'meta'}>
      To {list(folded ? message.to.slice(0, 2) : message.to)}
      {folded && (
        <>
          {' and '}
          <button type="button" className="link-button more-recipients" onClick={() => setAll(true)}>
            {message.to.length - 2} more
          </button>
        </>
      )}
      {message.cc.length > 0 && <>, cc {list(message.cc)}</>}
      {message.bcc.length > 0 && <>, bcc {list(message.bcc)}</>}
    </span>
  );
}

/** Click selects (Ctrl/Cmd+click adds), Ctrl/Cmd+C copies the files, double-click or Enter opens. */
export function AttachmentList({ message }: { message: Message }) {
  const toast = useToast();
  const files = message.attachments.filter((a) => !a.isInline);
  const [selected, setSelected] = useState<string[]>([]);
  if (files.length === 0) return null;

  const copy = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await api.copyAttachments(message.id, ids);
      toast(ids.length === 1 ? `Copied ${files.find((a) => a.id === ids[0])?.name ?? 'attachment'}` : `Copied ${ids.length} attachments`);
    } catch (e) {
      toast(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div
      className="attachments"
      onBlur={(e) => {
        // Clicking anywhere else clears the selection, like a file manager.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSelected([]);
      }}
    >
      {files.map((a) => (
        <button
          key={a.id}
          type="button"
          className="attachment-chip"
          aria-pressed={selected.includes(a.id)}
          title={`${a.name}\nDouble-click to open, ${isMac ? 'Cmd' : 'Ctrl'}+C to copy`}
          onClick={(e) => {
            const add = isMac ? e.metaKey : e.ctrlKey;
            setSelected((cur) => (add ? (cur.includes(a.id) ? cur.filter((x) => x !== a.id) : [...cur, a.id]) : [a.id]));
          }}
          onDoubleClick={() => void api.openAttachment(message.id, a.id)}
          onKeyDown={(e) => {
            const mod = isMac ? e.metaKey : e.ctrlKey;
            if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
              e.preventDefault();
              void copy(selected.length > 0 ? selected : [a.id]);
            } else if (mod && e.key.toLowerCase() === 'a') {
              e.preventDefault();
              setSelected(files.map((f) => f.id));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void api.openAttachment(message.id, a.id);
            }
          }}
        >
          <FileIcon name={a.name} contentType={a.contentType} />
          <span className="name">{a.name}</span>
          <span className="size">{formatSize(a.size)}</span>
        </button>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-icon attachments-copy"
        aria-label={files.length === 1 ? 'Copy attachment' : 'Copy all attachments'}
        title={files.length === 1 ? 'Copy attachment' : 'Copy all attachments'}
        onClick={() => void copy(files.map((a) => a.id))}
      >
        <Copy size={15} />
      </button>
    </div>
  );
}

/** Per-message actions shown as icons in the top right of an expanded card. */
type MessageActions = {
  reply: () => void;
  replyAll: () => void;
  forward: () => void;
  popOut: () => void;
  more: (anchor: HTMLElement) => void;
  /** Reply with this line already written at the top. */
  replyWith: (text: string) => void;
};

type IconActions = Omit<MessageActions, 'replyWith'> & { findTimes?: () => void; findingTimes?: boolean };

function MessageActionIcons({ actions, disabled }: { actions: IconActions; disabled: boolean }) {
  const items: { label: string; icon: React.ReactNode; run: (e: React.MouseEvent<HTMLButtonElement>) => void; pressed?: boolean }[] = [
    { label: 'Reply', icon: <Reply size={16} />, run: actions.reply },
    { label: 'Reply all', icon: <ReplyAll size={16} />, run: actions.replyAll },
    { label: 'Forward', icon: <Forward size={16} />, run: actions.forward },
    ...(actions.findTimes ? [{ label: 'Find times', icon: <CalendarSearch size={16} />, run: actions.findTimes, pressed: !!actions.findingTimes }] : []),
    { label: 'Open in new window', icon: <ExternalLink size={15} />, run: actions.popOut },
    { label: 'More actions', icon: <MoreHorizontal size={16} />, run: (e) => actions.more(e.currentTarget) },
  ];
  return (
    <div className="message-actions">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={it.label}
          aria-pressed={it.pressed}
          title={it.label === 'Find times' ? 'Find times: check the times this email proposes against your calendar (sends the email to the AI)' : it.label}
          disabled={disabled}
          onClick={it.run}
        >
          {it.icon}
        </button>
      ))}
    </div>
  );
}

function MessageView({
  message,
  expanded,
  onExpand,
  onCollapse,
  onChanged,
  actions,
  actionsDisabled,
}: {
  message: Message;
  expanded: boolean;
  onExpand: () => void;
  /** Set for messages that can fold back to one line (not the one that was opened). */
  onCollapse?: () => void;
  onChanged: (m: Message) => void;
  actions: MessageActions;
  actionsDisabled: boolean;
}) {
  const { accountById, settings } = useApp();
  const acc = accountById(message.accountId);
  const setActiveAddress = useCopyHoveredAddress();
  const split = useMemo(() => splitQuoted(message.bodyHtml), [message.bodyHtml]);
  const [showQuoted, setShowQuoted] = useState(false);
  const [findingTimes, setFindingTimes] = useState(false);
  // A click on the header area (date line included) that isn't selecting text, following a
  // link, pressing a button or picking up a name to copy.
  const headerClick = (e: React.MouseEvent) => !!window.getSelection()?.isCollapsed && !(e.target as Element).closest('a, button, .addr');

  if (!expanded) {
    return (
      // The whole row opens it, date line included.
      <div className="message-entry collapsed-entry" onClick={(e) => headerClick(e) && onExpand()}>
        <time className="message-timestamp" dateTime={message.receivedAt}>
          {fullTime(message.receivedAt)}
        </time>
        <div className="message-block collapsed">
          {/* Not a <button>: the sender's name inside is focusable for copying, and clicking
              it focuses the name rather than expanding. */}
          <div
            className="collapsed-message"
            role="button"
            tabIndex={0}
            aria-expanded={false}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              onExpand();
            }}
          >
            <AddressName className="collapsed-sender" address={message.from} label={message.from.name || message.from.email} onActive={setActiveAddress} /> · {message.snippet}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="message-entry">
      {/* The date line is part of the header: it folds the message back too. */}
      <time
        className={onCollapse ? 'message-timestamp collapsible' : 'message-timestamp'}
        dateTime={message.receivedAt}
        title={onCollapse ? 'Collapse' : undefined}
        onClick={onCollapse ? (e) => headerClick(e) && onCollapse() : undefined}
      >
        {fullTime(message.receivedAt)}
      </time>
      <div className="message-block">
        <div
          className={onCollapse ? 'message-head collapsible' : 'message-head'}
          {...(onCollapse && {
            role: 'button',
            tabIndex: 0,
            'aria-expanded': true,
            title: 'Collapse',
            onClick: (e: React.MouseEvent) => {
              if (headerClick(e)) onCollapse();
            },
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              onCollapse();
            },
          })}
        >
          <div className="who">
            <span className="name-line">
              <AddressName className="name" address={message.from} label={message.from.name || message.from.email} onActive={setActiveAddress} />
              {acc && (
                <span className="acc-chip" title={acc.displayName}>
                  <span className="acc-dot" style={{ background: acc.color }} />
                  <span className="acc-name">{acc.displayName}</span>
                </span>
              )}
            </span>
            <RecipientLine message={message} onActive={setActiveAddress} />
          </div>
          <MessageActionIcons actions={{ ...actions, findTimes: () => setFindingTimes((v) => !v), findingTimes }} disabled={actionsDisabled} />
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
        {message.meeting && <MeetingCard message={message} onChanged={onChanged} />}
        {findingTimes && <ProposedTimes message={message} onClose={() => setFindingTimes(false)} onReply={actions.replyWith} />}
        <AttachmentList message={message} />
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
  // Inline draft closed with Escape: shown collapsed until reopened.
  const [closedDraftId, setClosedDraftId] = useState<string | null>(null);
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

  /** `opening` goes on the first line of a new reply ("Find times"). */
  const startDraft = async (mode: DraftMode, source: Message | null = selectedMessage, opening?: string) => {
    if (!source || !selectedMessage) return;
    const open = thread?.drafts.find((d) => !d.poppedOut);
    if (open) {
      setClosedDraftId(null);
      setFocusDraft(true);
      // A reply is already being written: don't touch it, offer the line to paste.
      if (opening) {
        await navigator.clipboard?.writeText(opening).catch(() => {});
        toast('Copied the reply line; paste it into your draft');
      }
      return;
    }
    await api.createDraft({ mode, sourceMessageId: source.id, opening });
    setFocusDraft(true);
    await loadThread(selectedMessage.id);
  };

  // Removing the opened message moves the selection on; removing another message in the
  // thread just drops it from the thread.
  const afterRemoving = (m: Message) => {
    if (m.id === selectedMessage?.id) onRemoved();
    else if (selectedMessage) loadThread(selectedMessage.id);
  };

  const removeWithUndo = async (kind: 'archive' | 'delete', m: Message | null = selectedMessage) => {
    if (!m || !selectedMessage) return;
    const ids = [m.id];
    const original = m.folderId;
    if (kind === 'archive') await api.archive(ids);
    else await api.deleteMessages(ids);
    afterRemoving(m);
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

  const moreMenu = async (anchor: HTMLElement, m: Message) => {
    if (!selectedMessage) return;
    const openedId = selectedMessage.id;
    const folders: Folder[] = await api.listFolders(m.accountId);
    const items: MenuItem[] = [
      { label: 'Archive', onSelect: () => removeWithUndo('archive', m) },
      { label: 'Delete', onSelect: () => removeWithUndo('delete', m) },
      { label: m.isRead ? 'Mark as unread' : 'Mark as read', separatorBefore: true, onSelect: async () => {
        await api.markRead([m.id], !m.isRead);
        loadThread(openedId);
      } },
      { label: m.isFlagged ? 'Unflag' : 'Flag', onSelect: async () => {
        await api.setFlag([m.id], !m.isFlagged);
        loadThread(openedId);
      } },
      ...folders
        .filter((f) => f.id !== m.folderId && f.role !== 'drafts')
        .map((f, i) => ({
          label: `Move to ${f.name}`,
          separatorBefore: i === 0,
          onSelect: async () => {
            await api.moveMessages([m.id], f.id);
            afterRemoving(m);
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
        <div className="reading-toolbar back-only">
          <button type="button" className="btn btn-ghost back-button" onClick={onBack}>
            <ArrowLeft size={15} /> Back
          </button>
        </div>
        <div className="reading-scroll">
          <div className="reading-content">
            {error && <span className="error-text">{error}</span>}
            {draft &&
              (inOutbox(draft) ? (
                <OutboxItem key={draft.id} initial={draft} onGone={onBack} onEdit={setDraft} />
              ) : draft.poppedOut ? (
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
      {/* Actions live on each message card; this bar only carries Back on narrow layouts. */}
      <div className="reading-toolbar back-only">
        <button type="button" className="btn btn-ghost back-button" onClick={onBack} aria-label="Back to list">
          <ArrowLeft size={15} />
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
            <div className="thread-header">
              <h2 className="thread-subject">{thread.subject || '(no subject)'}</h2>
              <button type="button" className="btn btn-ghost btn-icon thread-close" aria-label="Close" title="Close" onClick={onBack}>
                <X size={18} />
              </button>
            </div>
            {inlineDraft &&
              (inlineDraft.poppedOut ? (
                <PoppedOutDraft draft={inlineDraft} />
              ) : inlineDraft.id === closedDraftId ? (
                <ClosedDraft
                  draft={inlineDraft}
                  onOpen={() => {
                    setClosedDraftId(null);
                    setFocusDraft(true);
                  }}
                />
              ) : (
                <Compose
                  key={inlineDraft.id}
                  initial={inlineDraft}
                  layout="inline"
                  autoFocus={focusDraft}
                  onDone={(outcome) => {
                    setFocusDraft(false);
                    if (outcome === 'closed') setClosedDraftId(inlineDraft.id);
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
                      actionsDisabled={!current}
                      actions={{
                        reply: () => void startDraft('reply', m),
                        replyAll: () => void startDraft('replyAll', m),
                        forward: () => void startDraft('forward', m),
                        popOut: () => void api.popOut('message', m.id),
                        more: (anchor) => void moreMenu(anchor, m),
                        replyWith: (text) => void startDraft('reply', m, text),
                      }}
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
