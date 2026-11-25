import { useEffect, useState, type MouseEvent } from 'react';
import { Archive, Calendar, FileText, Folder as FolderIcon, Inbox, Send, Settings as Gear, Trash2, Users, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import type { Account, CalendarInfo, Folder, FolderRole } from '../api/types';
import { useApp } from '../state/app';
import { Avatar, Menu, useToast, type Anchor, type MenuItem } from './ui';
import { RemoveAccountDialog, ApprovalDialog } from '../views/AccountDialogs';
import type { AddAccountResult } from '../api/types';
import { webCalendarNote } from '../lib/webCalendar';
import { now } from '../lib/clock';
import { useTick } from '../lib/useTick';

// Order of an account's folders in its sidebar group; user folders follow, by name.
const GROUP_ORDER: FolderRole[] = ['inbox', 'sent', 'drafts', 'archive', 'deleted', 'junk'];
const ROLE_ICONS: Partial<Record<FolderRole, LucideIcon>> = { sent: Send, drafts: FileText, archive: Archive, deleted: Trash2 };

function sortFolders(folders: Folder[], order: FolderRole[]): { folder: Folder; depth: number }[] {
  const roleIndex = (f: Folder) => (f.role ? order.indexOf(f.role) : 99);
  const children = (parentId?: string) =>
    folders
      .filter((f) => (f.parentId ?? undefined) === parentId)
      .sort((a, b) => roleIndex(a) - roleIndex(b) || a.name.localeCompare(b.name));
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parentId: string | undefined, depth: number) => {
    for (const f of children(parentId)) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

export function Sidebar() {
  const app = useApp();
  const { route, scope, accounts, graphAccounts, me, mailVersion } = app;
  const toast = useToast();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [menu, setMenu] = useState<{ anchor: Anchor; items: MenuItem[] } | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [approval, setApproval] = useState<AddAccountResult | null>(null);

  useEffect(() => {
    // Ask per account: without an account the backend returns combined per-role totals, not each account's folders.
    let live = true;
    Promise.all(graphAccounts.map((a) => api.listFolders(a.id).catch(() => [] as Folder[]))).then((lists) => {
      if (live) setFolders(lists.flat());
    });
    return () => {
      live = false;
    };
  }, [mailVersion, graphAccounts]);

  useEffect(() => {
    if (route.view === 'calendar') api.listCalendars().then(setCalendars);
  }, [route.view, accounts]);

  const inboxUnread = graphAccounts.reduce((n, a) => n + (a.unread ?? 0), 0);
  const inMail = route.view === 'mail';
  const isRole = (role: FolderRole) => !('id' in scope.folder) && scope.folder.role === role;

  const openMail = (accountId: string | undefined, folder: { role: FolderRole } | { id: string }) => {
    app.setScope({ accountId, folder, tab: 'all' });
    app.navigate({ view: 'mail' });
  };

  // Sign in again to an account whose sign-in expired or was never saved.
  const signInAgain = async (a: Account) => {
    try {
      const r = await api.addAccount(a.email);
      if (r.kind === 'needsAdminApproval') setApproval(r);
      else if (r.kind === 'error') toast(r.message);
      else if (r.kind === 'added') toast(`Signed in to ${r.account.displayName}`);
    } catch (err) {
      toast(String(err));
    }
  };

  const accountMenu = (e: MouseEvent, a: Account) => {
    e.preventDefault();
    const items: MenuItem[] = [];
    if (a.kind === 'web') {
      items.push({
        label: 'Request approval',
        onSelect: async () => setApproval(await api.upgradeWebAccount(a.id)),
      });
      items.push({ label: 'Reload', onSelect: () => api.reloadWebAccount(a.id) });
    } else {
      if (a.syncState === 'needsAuth') items.push({ label: 'Sign in again', onSelect: () => signInAgain(a) });
      items.push({
        label: 'Sync now',
        onSelect: () => api.syncNow(a.id),
      });
    }
    items.push({ label: 'Account settings…', onSelect: () => app.openSettings(`account:${a.id}`), separatorBefore: true });
    items.push({ label: 'Remove account…', danger: true, onSelect: () => setRemoving(a) });
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, items });
  };

  const accountSelected = (a: Account) => (a.kind === 'web' ? route.view === 'web' && route.param === a.id : inMail && scope.accountId === a.id && isRole('inbox'));

  useTick();

  const calendarSection = () => {
    const rows = accounts.map((a) => {
      if (a.kind === 'web' && !a.webCalendar)
        return (
          <label key={a.id} className="cal-check disabled" title="Turn on “Show this calendar in Calendar” in the account’s settings">
            <input type="checkbox" disabled />
            {a.displayName} (web only)
          </label>
        );
      const cals = calendars.filter((c) => c.accountId === a.id);
      const visible = cals.some((c) => c.visible);
      const note = webCalendarNote(a, now());
      return (
        <div key={a.id}>
          <label className={`cal-check${cals.length === 0 ? ' disabled' : ''}`}>
            <input
              type="checkbox"
              checked={visible}
              disabled={cals.length === 0}
              style={{ accentColor: a.color }}
              onChange={async (e) => {
                for (const c of cals) await api.setCalendarVisible(c.id, e.target.checked);
                setCalendars(await api.listCalendars());
                app.bumpMail();
              }}
            />
            {a.displayName}
            {a.kind === 'web' && (
              <>
                {' '}
                <span className="web-tag">web</span>
              </>
            )}
          </label>
          {note && (
            <div className="cal-note" title={a.webCalendarError ? 'Showing the last events read' : undefined}>
              {note}
            </div>
          )}
          {cals.length > 1 &&
            cals.map((c) => (
              <label key={c.id} className="cal-check" style={{ paddingLeft: 34 }}>
                <input
                  type="checkbox"
                  checked={c.visible}
                  style={{ accentColor: c.color }}
                  onChange={async (e) => {
                    await api.setCalendarVisible(c.id, e.target.checked);
                    setCalendars(await api.listCalendars());
                    app.bumpMail();
                  }}
                />
                {c.name}
              </label>
            ))}
        </div>
      );
    });
    return (
      <>
        <div className="nav-section">Calendars</div>
        {rows}
      </>
    );
  };

  const single = graphAccounts.length === 1;
  const webAccounts = accounts.filter((a) => a.kind === 'web');

  // With one mail account, the unified scope (no account) shows the same mail, so it highlights that account's rows too.
  const inAccount = (id: string) => scope.accountId === id || (single && !scope.accountId);

  const accountTitle = (a: Account) => (a.syncState === 'needsAuth' ? `Sign-in needed${a.syncError ? `: ${a.syncError}` : ''}` : a.syncState === 'error' ? a.syncError : a.email);

  const signInTag = (a: Account) =>
    a.syncState === 'needsAuth' && (
      <span
        role="button"
        tabIndex={0}
        className="web-tag sign-in-tag"
        title="Sign in again"
        onClick={(e) => {
          e.stopPropagation();
          signInAgain(a);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            signInAgain(a);
          }
        }}
      >
        sign in
      </span>
    );

  const calendarItem = (
    <button type="button" className={`nav-item${route.view === 'calendar' ? ' selected' : ''}`} onClick={() => app.navigate({ view: 'calendar' })}>
      <Calendar size={16} />
      <span className="label">Calendar</span>
    </button>
  );
  const peopleItem = (
    <button type="button" className={`nav-item${route.view === 'people' ? ' selected' : ''}`} onClick={() => app.navigate({ view: 'people' })}>
      <Users size={16} />
      <span className="label">People</span>
    </button>
  );

  // One mail account's group: its name, then Inbox, (Calendar, People), Sent, Drafts, Archive, Deleted and its own folders.
  const accountGroup = (a: Account) => {
    const own = folders.filter((f) => f.accountId === a.id);
    const list = sortFolders(own.filter((f) => f.role !== 'inbox'), GROUP_ORDER);
    const inboxSelected = inMail && inAccount(a.id) && isRole('inbox');
    return (
      <div key={a.id} className="acc-group">
        <div className="nav-section acc-head" onContextMenu={(e) => accountMenu(e, a)} title={accountTitle(a)}>
          <span className="acc-square" style={{ background: a.color }} />
          <span className="grow">{a.displayName}</span>
          {signInTag(a)}
        </div>
        <button type="button" className={`nav-item${inboxSelected ? ' selected' : ''}`} onClick={() => openMail(a.id, { role: 'inbox' })} onContextMenu={(e) => accountMenu(e, a)}>
          <Inbox size={16} />
          <span className="label">Inbox</span>
          {a.unread === null ? <span className="neutral-dot" aria-label="Unread count unavailable" /> : a.unread > 0 && <span className="count">{a.unread}</span>}
        </button>
        {single && calendarItem}
        {single && peopleItem}
        {list.map(({ folder: f, depth }) => {
          const selected = inMail && inAccount(a.id) && ('id' in scope.folder ? scope.folder.id === f.id : f.role !== null && isRole(f.role));
          const count = f.role === 'drafts' ? f.total : f.unread;
          const Icon = (f.role && ROLE_ICONS[f.role]) || FolderIcon;
          return (
            <button
              key={f.id}
              type="button"
              className={`nav-item${selected ? ' selected' : ''}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => openMail(a.id, f.role ? { role: f.role } : { id: f.id })}
            >
              <Icon size={16} />
              <span className="label">{f.name}</span>
              {count > 0 && <span className="count">{count}</span>}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <nav className="sidebar" aria-label="Sidebar">
      <div className="sidebar-scroll">
        {!single && (
          <>
            <button type="button" className={`nav-item${inMail && !scope.accountId && isRole('inbox') ? ' selected' : ''}`} onClick={() => openMail(undefined, { role: 'inbox' })}>
              <Inbox size={16} />
              <span className="label">{graphAccounts.length > 1 ? 'All inboxes' : 'Inbox'}</span>
              {inboxUnread > 0 && <span className="count">{inboxUnread}</span>}
            </button>
            {calendarItem}
            {peopleItem}
          </>
        )}

        {graphAccounts.map(accountGroup)}

        {route.view === 'calendar' && calendarSection()}

        <div className="nav-section">
          <span className="grow">{graphAccounts.length > 0 ? 'Other accounts' : 'Accounts'}</span>
          <button type="button" aria-label="Add account" title="Add account" onClick={() => app.openSettings('accounts')}>
            +
          </button>
        </div>
        {webAccounts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`nav-item${accountSelected(a) ? ' selected' : ''}`}
            onClick={() => app.navigate({ view: 'web', param: a.id })}
            onContextMenu={(e) => accountMenu(e, a)}
            title={accountTitle(a)}
          >
            <span className="acc-square" style={{ background: a.color }} />
            <span className="label">{a.displayName}</span>
            <span className="web-tag">web</span>
            {a.unread === null ? <span className="neutral-dot" aria-label="Unread count unavailable" /> : a.unread > 0 && <span className="count">{a.unread}</span>}
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <Avatar name={me.name || '?'} small me />
        <div className="footer-text">
          <span className="name">{me.name}</span>
          <span className="email" title={me.email}>
            {me.email}
          </span>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Settings" onClick={() => app.openSettings()}>
          <Gear size={16} />
        </button>
      </div>

      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
      {removing && <RemoveAccountDialog account={removing} onClose={() => setRemoving(null)} />}
      {approval && <ApprovalDialog result={approval} onClose={() => setApproval(null)} />}
    </nav>
  );
}
