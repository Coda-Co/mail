import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Folder, MessageSummary, ViewScope, SearchField, SearchResult } from '../api/types';
import { useApp } from '../state/app';
import { useCommand } from '../lib/commands';
import { MessageList } from '../components/MessageList';
import { ReadingPane, type Selection } from '../components/ReadingPane';
import { Agenda } from '../components/Agenda';
import { Resizer } from '../components/Resizer';
import { SearchHeader, type SearchState } from '../components/SearchHeader';
import { FolderBar, scopeTitle } from '../components/FolderBar';
import { Avatar, useToast } from '../components/ui';
import { plural } from '../lib/text';

const PAGE = 100;

/**
 * The open message for each mailbox and folder, kept while the app runs, so
 * going to Calendar or People (or another mailbox) and back reopens it.
 */
const openByScope = new Map<string, Selection>();
const scopeKey = (s: ViewScope) => `${s.accountId ?? ''}|${'role' in s.folder ? `role:${s.folder.role}` : `id:${s.folder.id}`}|${s.tab}`;

const FIELD_KEY = 'mail.searchField';
const FIELDS: SearchField[] = ['from', 'to', 'subject', 'content', 'all'];

/** The search field last used; From by default. */
function lastSearchField(): SearchField {
  try {
    const v = localStorage.getItem(FIELD_KEY) as SearchField | null;
    if (v && FIELDS.includes(v)) return v;
  } catch {
    // Storage unavailable: use the default.
  }
  return 'from';
}

function errorText(e: unknown, fallback = 'Something went wrong'): string {
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' && e.message) return e.message;
  return fallback;
}

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
  const [selection, setSelectionState] = useState<Selection | null>(() => openByScope.get(scopeKey(scope)) ?? null);
  // Set when a remembered message is reopened, until the list confirms it's still there.
  const restored = useRef<string | null>(selection?.kind === 'message' ? selection.id : null);
  const setSelection = (sel: Selection | null) => {
    restored.current = null;
    setSelectionState(sel);
    if (sel) openByScope.set(scopeKey(scope), sel);
    else openByScope.delete(scopeKey(scope));
  };
  // Unread view: messages opened here stay in the list, now read, until you leave the view,
  // so the one you're reading doesn't vanish from under you.
  const keptInUnread = useRef<Map<string, MessageSummary>>(new Map());
  // How many of the listed messages are kept ones, not from the server's page (paging skips them).
  const extra = useRef(0);
  const keptFor = useRef(scopeKey(scope));
  if (keptFor.current !== scopeKey(scope)) {
    keptFor.current = scopeKey(scope);
    keptInUnread.current = new Map();
  }
  const [folders, setFolders] = useState<Folder[]>([]);
  const [search, setSearch] = useState<SearchState>(() => ({ query: { text: '', field: lastSearchField(), scope, allFolders: false } }));
  const [result, setResult] = useState<SearchResult | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Runs the pending local search now instead of after the typing delay.
  const runSearchNow = useRef<(() => void) | null>(null);
  // The query whose results came from the server; a sync shouldn't replace them with local ones.
  const serverResultFor = useRef<SearchState | null>(null);
  const toast = useToast();
  const searchInput = useRef<HTMLInputElement>(null);

  const account = scope.accountId ? accountById(scope.accountId) : undefined;
  const folderName = useMemo(() => scopeTitle(scope, folders), [scope, folders]);
  const scopeLabel = account ? `${folderName}, ${account.displayName}` : folderName;

  useEffect(() => {
    api.listFolders(scope.accountId).then(setFolders);
  }, [scope.accountId, mailVersion]);

  // Normal list.
  useEffect(() => {
    let cancelled = false;
    const kept = keptInUnread.current;
    api.listMessages(scope, PAGE, 0).then(async (fresh) => {
      let list = fresh;
      const missing = [...kept.keys()].filter((id) => !fresh.some((m) => m.id === id));
      if (scope.tab === 'unread' && missing.length > 0) {
        // Put back the ones that are only missing because they've been read; drop any moved or deleted.
        const back = await Promise.all(missing.map((id) => api.getMessage(id).catch(() => null)));
        const readAgain: MessageSummary[] = [];
        back.forEach((m, i) => {
          const was = kept.get(missing[i])!;
          if (m && m.folderId === was.folderId) readAgain.push({ ...was, isRead: m.isRead, isFlagged: m.isFlagged });
          else kept.delete(missing[i]);
        });
        const oldest = fresh.length === PAGE ? fresh[fresh.length - 1].receivedAt : '';
        list = [...fresh, ...readAgain.filter((m) => m.receivedAt >= oldest)].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
      }
      if (cancelled) return;
      extra.current = list.length - fresh.length;
      setMessages(list);
      setHasMore(fresh.length === PAGE);
      // A reopened message that has since moved or been deleted: don't reopen it.
      if (restored.current && !list.some((m) => m.id === restored.current)) {
        openByScope.delete(scopeKey(scope));
        setSelectionState(null);
      }
      restored.current = null;
    });
    return () => {
      cancelled = true;
    };
  }, [scope, mailVersion]);

  // A new scope reopens what was last open there, if anything.
  useEffect(() => {
    const sel = openByScope.get(scopeKey(scope)) ?? null;
    restored.current = sel?.kind === 'message' ? sel.id : null;
    setSelectionState(sel);
    setSearch((s) => ({ query: { text: '', field: s.query.field, scope, allFolders: false } }));
    setResult(null);
  }, [scope]);

  useEffect(() => {
    try {
      if (search.query.field) localStorage.setItem(FIELD_KEY, search.query.field);
    } catch {
      // Not remembered; fine.
    }
  }, [search.query.field]);

  // Search filters the current view, as you type.
  useEffect(() => {
    if (!searchActive) {
      setResult(null);
      setSearchPending(false);
      setSearchError(null);
      runSearchNow.current = null;
      return;
    }
    if (serverResultFor.current === search) return;
    let cancelled = false;
    let started = false;
    setSearchPending(true);
    const run = () => {
      if (started) return;
      started = true;
      clearTimeout(t);
      api
        .search({ ...search.query, scope })
        .then(
          (r) => {
            if (cancelled) return;
            setResult(r);
            setSearchError(null);
          },
          (e) => {
            if (cancelled) return;
            setResult(null);
            setSearchError(errorText(e));
          },
        )
        .finally(() => {
          if (!cancelled) setSearchPending(false);
        });
    };
    const t = setTimeout(run, 120);
    runSearchNow.current = run;
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchActive, search, scope, mailVersion]);

  // While a search runs the list shows "Searching…", never the folder's mail or the previous query's results.
  const list = searchActive ? (searchPending || searchError ? [] : (result?.messages ?? [])) : (messages ?? []);

  const loadMore = useCallback(() => {
    if (!hasMore || searchActive || !messages) return;
    setHasMore(false);
    api.listMessages(scope, PAGE, messages.length - extra.current).then((more) => {
      setMessages((m) => [...(m ?? []), ...more.filter((x) => !m?.some((y) => y.id === x.id))]);
      setHasMore(more.length === PAGE);
    });
  }, [hasMore, searchActive, messages, scope]);

  const select = (m: MessageSummary) => {
    if (scope.tab === 'unread' && !m.isDraft) keptInUnread.current.set(m.id, m);
    setSelection({ kind: m.isDraft ? 'draft' : 'message', id: m.id });
  };

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
    setSearch((s) => ({ query: { text: '', field: s.query.field, scope, allFolders: false } }));
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

  const searchServer = async () => {
    if (serverBusy) return;
    const forQuery = search;
    setServerBusy(true);
    try {
      const r = await api.searchServer({ ...forQuery.query, scope });
      serverResultFor.current = forQuery;
      setResult(r);
      setSearchError(null);
    } catch (e) {
      toast(errorText(e, "Couldn't search the server"));
    } finally {
      setServerBusy(false);
    }
  };

  // Enter: search now. If this search has already run and found nothing here, ask the server.
  const submitSearch = () => {
    if (searchPending) {
      runSearchNow.current?.();
      return;
    }
    if (result && !result.fromServer && result.messages.length === 0 && search.query.text.trim()) void searchServer();
  };

  const panes = (
    <div className={`mail-panes${selection ? ' has-selection' : ''}`}>
      <section className="list-pane" aria-label={searchActive ? 'Results' : 'Message list'}>
        {!searchActive && (
          <div className="list-header">
            <FolderBar scope={scope} folders={folders} onChange={app.setScope} />
          </div>
        )}
        <MessageList
          draftTags={searchActive || scope.tab !== 'outbox'}
          messages={list}
          selectedId={selection?.id ?? null}
          onSelect={select}
          onLoadMore={loadMore}
          empty={
            messages === null
              ? 'Loading…'
              : searchActive
                ? searchError
                  ? `Search failed: ${searchError}`
                  : searchPending || !result
                    ? (
                        <span className="list-searching" role="status">
                          <LoaderCircle size={16} className="spin" aria-hidden />
                          Searching…
                        </span>
                      )
                    : 'No messages match these filters'
                : !account
                  ? 'Add a mailbox with + in the sidebar'
                  : scope.tab === 'unread'
                    ? 'No unread messages'
                    : scope.tab === 'outbox'
                      ? 'Nothing waiting to send'
                      : `Nothing in ${folderName}`
          }
          header={searchActive && result && !searchPending ? <ContactCard result={result} onEmail={(email, name) => newMessage({ email, name })} /> : undefined}
          footer={
            searchActive && result && !searchPending && !result.fromServer ? (
              <button type="button" className="btn search-server" onClick={searchServer} disabled={serverBusy}>
                {serverBusy ? 'Searching the server…' : 'Search the server'}
              </button>
            ) : searchActive && !searchPending && result?.fromServer ? (
              <div className="list-empty">Includes results from the server</div>
            ) : null
          }
        />
      </section>
      <Resizer variable="--list-w" pane="before" label="Resize message list" className="list-resizer" />
      <ReadingPane selection={selection} onBack={() => setSelection(null)} onRemoved={afterRemoved} />
    </div>
  );

  if (searchActive) {
    return (
      <div className="mail-view">
        <div className="mail-center search-mode">
          <SearchHeader state={search} onChange={setSearch} onClose={closeSearch} scopeLabel={scopeLabel} resultCount={result && !searchPending ? result.total : null} onSubmit={submitSearch} inputRef={searchInput} />
          {panes}
        </div>
      </div>
    );
  }

  return (
    <div className="mail-view">
      <div className="mail-center">{panes}</div>
      <Resizer variable="--agenda-w" pane="after" label="Resize agenda" className="agenda-resizer" />
      <Agenda />
    </div>
  );
}
