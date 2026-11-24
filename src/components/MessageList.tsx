import { useEffect, useRef } from 'react';
import { Flag, Paperclip } from 'lucide-react';
import type { MessageSummary } from '../api/types';
import { useApp } from '../state/app';
import { listTime } from '../lib/dates';

export function MessageRow({ m, selected, onSelect }: { m: MessageSummary; selected: boolean; onSelect: () => void }) {
  const { accountById } = useApp();
  const ref = useRef<HTMLButtonElement>(null);
  const acc = accountById(m.accountId);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const who = m.isDraft ? (m.to.map((a) => a.name || a.email).join(', ') || 'No recipients') : m.from.name || m.from.email;
  return (
    <button
      ref={ref}
      type="button"
      className={`message-row${selected ? ' selected' : ''}${m.isRead ? '' : ' unread'}`}
      onClick={onSelect}
      aria-current={selected}
      data-id={m.id}
    >
      <span className="line">
        <span className="acc-dot" style={{ background: acc?.color ?? '#6E7781' }} title={acc?.displayName} />
        <span className="from">
          {m.isDraft && <span className="draft-label">Draft</span>}
          {who}
        </span>
        <span className="icons">
          {m.isFlagged && <Flag size={13} aria-label="Flagged" />}
          {m.hasAttachments && <Paperclip size={14} aria-label="Has attachment" />}
        </span>
        <span className="time">{listTime(m.receivedAt)}</span>
      </span>
      <span className="subject">{m.subject || '(no subject)'}</span>
      <span className="snippet">
        {m.hasDraft && (
          <span className="draft-label" title="You started a reply in this conversation">
            Draft
          </span>
        )}
        {m.snippet}
      </span>
    </button>
  );
}

export function MessageList({
  messages,
  selectedId,
  onSelect,
  empty,
  onLoadMore,
  footer,
  header,
}: {
  messages: MessageSummary[];
  selectedId: string | null;
  onSelect: (m: MessageSummary) => void;
  empty: string;
  onLoadMore?: () => void;
  footer?: React.ReactNode;
  header?: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <div
      className="message-rows"
      ref={scroller}
      role="list"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (onLoadMore && el.scrollTop + el.clientHeight > el.scrollHeight - 200) onLoadMore();
      }}
    >
      {header}
      {messages.map((m) => (
        <MessageRow key={m.id} m={m} selected={m.id === selectedId} onSelect={() => onSelect(m)} />
      ))}
      {messages.length === 0 && <div className="list-empty">{empty}</div>}
      {footer}
    </div>
  );
}
