import { useEffect, useState, type MouseEvent } from 'react';
import { Calendar, Inbox, Search, Settings as Gear, Users } from 'lucide-react';
import { api } from '../api';
import type { Account, CalendarInfo, Folder, FolderRole } from '../api/types';
import { useApp } from '../state/app';
import { keyLabel } from '../lib/platform';
import { Avatar, Menu, useToast, type Anchor, type MenuItem } from './ui';
import { RemoveAccountDialog, ApprovalDialog } from '../views/AccountDialogs';
import type { AddAccountResult } from '../api/types';

const ROLE_ORDER: FolderRole[] = ['inbox', 'drafts', 'sent', 'archive', 'deleted', 'junk'];
const UNIFIED_ROLES: { role: FolderRole; name: string }[] = [
  { role: 'drafts', name: 'Drafts' },
  { role: 'sent', name: 'Sent' },
  { role: 'archive', name: 'Archive' },
  { role: 'deleted', name: 'Deleted' },
];

function sortFolders(folders: Folder[]): { folder: Folder; depth: number }[] {
  const roleIndex = (f: Folder) => (f.role ? ROLE_ORDER.indexOf(f.role) : 99);
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
  const { route, scope, accounts, graphAccounts, sync, me, mailVersion } = app;
  const toast = useToast();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [menu, setMenu] = useState<{ anchor: Anchor; items: MenuItem[] } | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [approval, setApproval] = useState<AddAccountResult | null>(null);

  useEffect(() => {
    api.listFolders(scope.accountId).then(setFolders);
  }, [scope.accountId, mailVersion, accounts]);

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

  const calendarSection = () => {
    const rows = accounts.map((a) => {
      if (a.kind === 'web')
        return (
          <label key={a.id} className="cal-check disabled">
            <input type="checkbox" disabled />
            {a.displayName} (web only)
          </label>
        );
      const cals = calendars.filter((c) => c.accountId === a.id);
      const visible = cals.some((c) => c.visible);
      return (
        <div key={a.id}>
          <label className="cal-check">
            <input
              type="checkbox"
              checked={visible}
              style={{ accentColor: a.color }}
              onChange={async (e) => {
                for (const c of cals) await api.setCalendarVisible(c.id, e.target.checked);
                setCalendars(await api.listCalendars());
                app.bumpMail();
              }}
            />
            {a.displayName}
          </label>
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

  const folderSection = () => {
    if (scope.accountId) {
      const list = sortFolders(folders.filter((f) => f.role !== 'inbox'));
      return list.map(({ folder: f, depth }) => {
        const selected = inMail && 'id' in scope.folder ? scope.folder.id === f.id : inMail && f.role !== null && isRole(f.role);
        const count = f.role === 'drafts' ? f.total : f.unread;
        return (
          <button
            key={f.id}
            type="button"
            className={`nav-item folder${selected ? ' selected' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => openMail(scope.accountId, f.role ? { role: f.role } : { id: f.id })}
          >
            <span className="label">{f.name}</span>
            {count > 0 && <span className="count">{count}</span>}
          </button>
        );
      });
    }
    return UNIFIED_ROLES.map(({ role, name }) => {
      const matching = folders.filter((f) => f.role === role);
      const count = role === 'drafts' ? matching.reduce((n, f) => n + f.total, 0) : matching.reduce((n, f) => n + f.unread, 0);
      const selected = inMail && isRole(role);
      return (
        <button key={role} type="button" className={`nav-item folder${selected ? ' selected' : ''}`} onClick={() => openMail(undefined, { role })}>
          <span className="label">{name}</span>
          {count > 0 && <span className="count">{count}</span>}
        </button>
      );
    });
  };

  const scopeAccount = scope.accountId ? accounts.find((a) => a.id === scope.accountId) : undefined;

  return (
    <nav className="sidebar" aria-label="Sidebar">
      <div className="brand">
        <div className="brand-logo">M</div>
        <span className="brand-name">Mail</span>
        {sync.demo && (
          <span className="demo-tag" title="Built-in sample data. Nothing here is real or synced. Run pnpm tauri dev for your accounts.">
            Demo data
          </span>
        )}
      </div>
      <button
        type="button"
        className="sidebar-search"
        onClick={() => {
          if (route.view !== 'mail') app.navigate({ view: 'mail' });
          app.setSearchActive(true);
        }}
      >
        <Search size={15} />
        <span>Search this view</span>
        <span className="kbd-hint">{keyLabel('Mod+E')}</span>
      </button>
      <div className="sidebar-scroll">
        <button type="button" className={`nav-item${inMail && !scope.accountId && isRole('inbox') ? ' selected' : ''}`} onClick={() => openMail(undefined, { role: 'inbox' })}>
          <Inbox size={16} />
          <span className="label">Inbox</span>
          {inboxUnread > 0 && <span className="count">{inboxUnread}</span>}
        </button>
        <button type="button" className={`nav-item${route.view === 'calendar' ? ' selected' : ''}`} onClick={() => app.navigate({ view: 'calendar' })}>
          <Calendar size={16} />
          <span className="label">Calendar</span>
        </button>
        <button type="button" className={`nav-item${route.view === 'people' ? ' selected' : ''}`} onClick={() => app.navigate({ view: 'people' })}>
          <Users size={16} />
          <span className="label">People</span>
        </button>

        {route.view === 'calendar' ? (
          calendarSection()
        ) : (
          <>
            <div className="nav-section">
              <span className="grow">Accounts</span>
              <button type="button" aria-label="Add account" title="Add account" onClick={() => app.openSettings('accounts')}>
                +
              </button>
            </div>
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`nav-item${accountSelected(a) ? ' selected' : ''}`}
                onClick={() => (a.kind === 'web' ? app.navigate({ view: 'web', param: a.id }) : openMail(a.id, { role: 'inbox' }))}
                onContextMenu={(e) => accountMenu(e, a)}
                title={a.syncState === 'needsAuth' ? `Sign-in needed${a.syncError ? `: ${a.syncError}` : ''}` : a.syncState === 'error' ? a.syncError : a.email}
              >
                <span className="acc-square" style={{ background: a.color }} />
                <span className="label">{a.displayName}</span>
                {a.kind === 'web' && <span className="web-tag">web</span>}
                {a.syncState === 'needsAuth' && (
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
                )}
                {a.unread === null ? <span className="neutral-dot" aria-label="Unread count unavailable" /> : a.unread > 0 && <span className="count">{a.unread}</span>}
              </button>
            ))}
            {inMail && (
              <>
                <div className="nav-section">{scopeAccount ? `Folders · ${scopeAccount.displayName}` : 'Folders'}</div>
                {folderSection()}
              </>
            )}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <Avatar name={me.name || '?'} small me />
        <div className="footer-text">
          <span className="name">{me.name}</span>
          <button
            type="button"
            className="status-line"
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
            title="Sync now"
            onClick={() => api.syncNow().catch((e) => toast(String(e)))}
          >
            <span className={`status-dot${sync.online ? (sync.syncing ? ' syncing' : '') : ' offline'}`} />
            {sync.label}
            {sync.outboxHeld > 0 && ` · ${sync.outboxHeld} held`}
          </button>
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
