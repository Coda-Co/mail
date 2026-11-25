import { useState, type MouseEvent, type ReactNode } from 'react';
import { Calendar, Globe, Plus, Settings as Gear, Users } from 'lucide-react';
import { api } from '../api';
import type { Account, AddAccountResult } from '../api/types';
import { useApp } from '../state/app';
import { useCommand } from '../lib/commands';
import { keyLabel } from '../lib/platform';
import type { MailboxSlot } from '../lib/shortcuts';
import { glyphLetters } from '../lib/glyph';
import { Avatar, Menu, useToast, type Anchor, type MenuItem } from './ui';
import { RemoveAccountDialog, ApprovalDialog } from '../views/AccountDialogs';

function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

function RailItem({
  label,
  selected,
  onClick,
  onContextMenu,
  children,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className={`rail-item${selected ? ' selected' : ''}`}>
      <button type="button" className="rail-button" aria-label={label} aria-current={selected ? 'page' : undefined} title={label} onClick={onClick} onContextMenu={onContextMenu}>
        {children}
      </button>
    </div>
  );
}

/**
 * The narrow bar down the left: Calendar and People (shared across
 * mailboxes) above the line, then one glyph per mailbox. Each mailbox is
 * its own space; there's no combined inbox.
 */
export function Rail() {
  const app = useApp();
  const { route, scope, accounts, me } = app;
  const toast = useToast();
  const [menu, setMenu] = useState<{ anchor: Anchor; items: MenuItem[] } | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [approval, setApproval] = useState<AddAccountResult | null>(null);

  const openMailbox = (a: Account) => {
    if (a.kind === 'web') {
      app.navigate({ view: 'web', param: a.id });
      return;
    }
    if (scope.accountId !== a.id) app.setScope({ accountId: a.id, folder: { role: 'inbox' }, tab: 'all' });
    app.navigate({ view: 'mail' });
  };

  const slots: MailboxSlot[] = [1, 2, 3, 4, 5, 6, 7];
  // A fixed number of calls in the same order every render, so hooks in a loop are fine.
  for (const n of slots)
    useCommand(`goMailbox${n}`, () => {
      const a = accounts[n - 1];
      if (!a) return false;
      openMailbox(a);
    });

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
      items.push({ label: 'Request approval', onSelect: async () => setApproval(await api.upgradeWebAccount(a.id)) });
      items.push({ label: 'Reload', onSelect: () => api.reloadWebAccount(a.id) });
    } else {
      if (a.syncState === 'needsAuth') items.push({ label: 'Sign in again', onSelect: () => signInAgain(a) });
      items.push({ label: 'Sync now', onSelect: () => api.syncNow(a.id) });
    }
    items.push({ label: 'Account settings…', onSelect: () => app.openSettings(`account:${a.id}`), separatorBefore: true });
    items.push({ label: 'Remove account…', danger: true, onSelect: () => setRemoving(a) });
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, items });
  };

  const isSelected = (a: Account) => (a.kind === 'web' ? route.view === 'web' && route.param === a.id : route.view === 'mail' && scope.accountId === a.id);

  const mailboxLabel = (a: Account, i: number) => {
    const lines = [a.displayName, a.email];
    if (a.kind === 'web') lines.push('Outlook on the web');
    if (a.syncState === 'needsAuth') lines.push(`Sign-in needed${a.syncError ? `: ${a.syncError}` : ''}. Right-click to sign in again.`);
    else if (a.syncState === 'error' && a.syncError) lines.push(a.syncError);
    if (a.unread) lines.push(`${a.unread} unread`);
    if (i < slots.length) lines.push(keyLabel(`Mod+${i + 3}`));
    return lines.join('\n');
  };

  return (
    <nav className="rail" aria-label="Calendar, people and mailboxes">
      <div className="rail-scroll">
        <RailItem label={`Calendar\n${keyLabel('Mod+1')}`} selected={route.view === 'calendar'} onClick={() => app.navigate({ view: 'calendar' })}>
          <span className="rail-icon">
            <Calendar size={18} />
          </span>
        </RailItem>
        <RailItem label={`People\n${keyLabel('Mod+2')}`} selected={route.view === 'people'} onClick={() => app.navigate({ view: 'people' })}>
          <span className="rail-icon">
            <Users size={18} />
          </span>
        </RailItem>

        <div className="rail-divider" role="separator" />

        {accounts.map((a, i) => {
          const { org, mailbox } = glyphLetters(a, accounts);
          const attention = a.syncState === 'needsAuth' ? 'auth' : a.syncState === 'error' ? 'error' : null;
          return (
            <RailItem key={a.id} label={mailboxLabel(a, i)} selected={isSelected(a)} onClick={() => openMailbox(a)} onContextMenu={(e) => accountMenu(e, a)}>
              <span className={`rail-glyph${a.kind === 'web' ? ' web' : ''}`} style={{ background: a.color }}>
                <span className="org">{org}</span>
                {mailbox && <span className="mailbox">{mailbox}</span>}
              </span>
              {!!a.unread && a.unread > 0 && <span className="rail-badge">{badgeText(a.unread)}</span>}
              {attention ? (
                <span className={`rail-status ${attention}`} aria-hidden>
                  !
                </span>
              ) : (
                a.kind === 'web' && (
                  <span className="rail-status web" aria-hidden>
                    <Globe size={10} />
                  </span>
                )
              )}
            </RailItem>
          );
        })}

        <div className="rail-item">
          <button type="button" className="rail-button rail-add" aria-label="Add account" title="Add account" onClick={() => app.openSettings('accounts')}>
            <Plus size={18} />
          </button>
        </div>
      </div>

      <div className="rail-footer">
        <button type="button" className="rail-button" aria-label="Settings" title="Settings" onClick={() => app.openSettings()}>
          <span className="rail-icon">
            <Gear size={18} />
          </span>
        </button>
        <span className="rail-me" title={me.email ? `${me.name}\n${me.email}` : me.name}>
          <Avatar name={me.name || '?'} small me />
        </span>
      </div>

      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
      {removing && <RemoveAccountDialog account={removing} onClose={() => setRemoving(null)} />}
      {approval && <ApprovalDialog result={approval} onClose={() => setApproval(null)} />}
    </nav>
  );
}
