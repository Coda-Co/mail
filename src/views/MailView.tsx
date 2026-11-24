import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api';
import type { Folder, ListTab, MessageSummary, SearchResult } from '../api/types';
import { useApp } from '../state/app';
import { useCommand } from '../lib/commands';
import { MessageList } from '../components/MessageList';
import { ReadingPane, type Selection } from '../components/ReadingPane';
import { Agenda } from '../components/Agenda';
import { SearchHeader, type SearchState } from '../components/SearchHeader';
import { Avatar, useToast } from '../components/ui';
import { plural } from '../lib/text';

const PAGE = 100;
const ROLE_NAMES: Record<string, string> = { inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', archive: 'Archive', deleted: 'Deleted', junk: 'Junk' };

function ContactCard({ result, onEmail }: { result: SearchResult; onEmail: (email: string, name: string) => void }) {
  const { accountById } = useApp();
  const toast = useToast();
  const p = result.contact;
  if (!p) return null;
  const accountNames = p.accountIds.map((id) => accountById(id)?.displayName).filter(Boolean).join(', ');
  return (
    <div className="contact-card">
      <Avatar name={p.name} />
      <span className="info">
        <span className="name">{p.name}</span>
        <span className="meta">
          {accountNames}
          {accountNames && ' · '}
          {plural(p.messageCount, 'message')}
        </span>
      </span>
      <button type="button" className="btn" onClick={() => onEmail(p.email, p.name)}>
        Email
      </button>
      <button
        type="button"
        className="btn"
        onClick={async () => {
          await navigator.clipboard.writeText(p.email).catch(() => {});
          toast(`Copied ${p.email}`);
        }}
      >
        Copy address
      </button>
    </div>
  );
}

export function MailView() {
  const app = useApp();
  const { scope, mailVersion, searchActive, setSearchActive, accountById } = app;
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [search, setSearch] = useState<SearchState>(() => ({ query: { text: '', scope, allFolders: false } }));
  const [result, setResult] = useState<SearchResult | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const autoSelected = useRef(false);

  const account = scope.accountId ? accountById(scope.accountId) : undefined;
  const folderName = useMemo(() => {
    if ('role' in scope.folder) return ROLE_NAMES[scope.folder.role];
    const id = scope.folder.id;
    return folders.find((f) => f.id === id)?.name ?? 'Folder';
  }, [scope.folder, folders]);
  const scopeLabel = `${folderName}, ${account ? account.displayName : 'all accounts'}`;

  useEffect(() => {
    api.listFolders(scope.accountId).then(setFolders);
  }, [scope.accountId, mailVersion]);

  // Normal list.
  useEffect(() => {
    let cancelled = false;
    api.listMessages(scope, PAGE, 0).then((list) => {
      if (cancelled) return;
      setMessages(list);
      setHasMore(list.length === PAGE);
      if (!autoSelected.current && list.length && window.innerWidth >= 960) {
        autoSelected.current = true;
        setSelection((s) => s ?? { kind: list[0].isDraft ? 'draft' : 'message', id: list[0].id });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [scope, mailVersion]);

  // Reset selection when the scope changes.
  useEffect(() => {
    setSelection(null);
    setSearch({ query: { text: '', scope, allFolders: false } });
    setResult(null);
  }, [scope]);

  // Search filters the current view.
  useEffect(() => {
    if (!searchActive) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.search({ ...search.query, scope }).then((r) => !cancelled && setResult(r));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchActive, search, scope, mailVersion]);

  const list = searchActive ? (result?.messages ?? messages ?? []) : (messages ?? []);

  const loadMore = useCallback(() => {
    if (!hasMore || searchActive || !messages) return;
    setHasMore(false);
    api.listMessages(scope, PAGE, messages.length).then((more) => {
      setMessages((m) => [...(m ?? []), ...more]);
      setHasMore(more.length === PAGE);
    });
  }, [hasMore, searchActive, messages, scope]);

  const select = (m: MessageSummary) => setSelection({ kind: m.isDraft ? 'draft' : 'message', id: m.id });

  const move = (delta: number) => {
    if (!list.length) return;
    const idx = selection ? list.findIndex((m) => m.id === selection.id) : -1;
    const next = list[Math.max(0, Math.min(list.length - 1, idx + delta))];
    if (next) select(next);
  };

  const afterRemoved = () => {
    const idx = selection ? list.findIndex((m) => m.id === selection.id) : -1;
    const next = list[idx + 1] ?? list[idx - 1];
    setSelection(next ? { kind: next.isDraft ? 'draft' : 'message', id: next.id } : null);
  };

  const newMessage = async (to?: { email: string; name: string }) => {
    const d = await api.createDraft({ mode: 'new', accountId: scope.accountId });
    if (to) await api.updateDraft({ ...d, to: [to] });
    setSelection({ kind: 'draft', id: d.id });
  };

  const closeSearch = () => {
    setSearchActive(false);
    setSearch({ query: { text: '', scope, allFolders: false } });
  };

  useCommand('newMessage', () => void newMessage());
  useCommand('next', () => move(1));
  useCommand('previous', () => move(-1));
  useCommand('search', () => {
    setSearchActive(true);
    setTimeout(() => searchInput.current?.focus(), 0);
  });
  useCommand('ctrlF', () => {
    if (app.settings.ctrlF !== 'find') return false;
    setSearchActive(true);
    setTimeout(() => searchInput.current?.focus(), 0);
  });
  useCommand('escape', () => {
    if (searchActive) {
      closeSearch();
      return;
    }
    if (selection && window.innerWidth < 960) {
      setSelection(null);
      return;
    }
    return false;
  });

  const setTab = (tab: ListTab) => app.setScope({ ...scope, tab });

  const searchServer = async () => {
    setServerBusy(true);
    try {
      setResult(await api.searchServer({ ...search.query, scope }));
    } finally {
      setServerBusy(false);
    }
  };

  const panes = (
    <div className={`mail-panes${selection ? ' has-selection' : ''}`}>
      <section className="list-pane" aria-label={searchActive ? 'Results' : 'Message list'}>
        {!searchActive && (
          <div className="list-header">
            <div className="list-title-row">
              <h1 className="view-title">{folderName}</h1>
              <button type="button" className="btn btn-primary" onClick={() => newMessage()}>
                <Plus size={14} strokeWidth={2.4} />
                New
              </button>
            </div>
            {account && (
              <div className="view-subtitle">
                <span className="acc-dot" style={{ background: account.color }} />
                {account.displayName}
              </div>
            )}
            <div className="tabs" role="tablist">
              {(['all', 'unread', 'flagged'] as ListTab[]).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={scope.tab === t} className={`tab${scope.tab === t ? ' selected' : ''}`} onClick={() => setTab(t)}>
                  {t === 'all' ? (account ? 'All' : 'All accounts') : t === 'unread' ? 'Unread' : 'Flagged'}
                </button>
              ))}
            </div>
          </div>
        )}
        <MessageList
          messages={list}
          selectedId={selection?.id ?? null}
          onSelect={select}
          onLoadMore={loadMore}
          empty={
            messages === null
              ? 'Loading…'
              : searchActive
                ? 'No messages match these filters'
                : scope.tab === 'unread'
                  ? 'No unread messages'
                  : scope.tab === 'flagged'
                    ? 'No flagged messages'
                    : `Nothing in ${folderName}`
          }
          header={searchActive && result ? <ContactCard result={result} onEmail={(email, name) => newMessage({ email, name })} /> : undefined}
          footer={
            searchActive && result && !result.fromServer ? (
              <button type="button" className="btn search-server" onClick={searchServer} disabled={serverBusy}>
                {serverBusy ? 'Searching the server…' : 'Search the server'}
              </button>
            ) : searchActive && result?.fromServer ? (
              <div className="list-empty">Includes results from the server</div>
            ) : null
          }
        />
      </section>
      <ReadingPane selection={selection} onBack={() => setSelection(null)} onRemoved={afterRemoved} />
    </div>
  );

  if (searchActive) {
    return (
      <div className="mail-view">
        <div className="mail-center search-mode">
          <SearchHeader state={search} onChange={setSearch} onClose={closeSearch} scopeLabel={scopeLabel} resultCount={result ? result.total : null} inputRef={searchInput} />
          {panes}
        </div>
      </div>
    );
  }

  return (
    <div className="mail-view">
      <div className="mail-center">{panes}</div>
      <Agenda />
    </div>
  );
}
