import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Globe, Plus } from 'lucide-react';
import { api } from '../api';
import type { Account, AddAccountResult } from '../api/types';
import { useApp } from '../state/app';
import { useCommand } from '../lib/commands';
import { keyLabel } from '../lib/platform';
import type { MailboxSlot } from '../lib/shortcuts';
import { Menu, useToast, type Anchor, type MenuItem } from './ui';
import { RemoveAccountDialog, ApprovalDialog } from '../views/AccountDialogs';

const SLOTS: MailboxSlot[] = [1, 2, 3, 4, 5, 6];

function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/** The account's name, plus the mailbox when another account has the same name (two mailboxes in one organisation). */
function tabName(a: Account, all: Account[]): string {
  const clash = all.some((o) => o.id !== a.id && o.displayName === a.displayName);
  return clash ? `${a.displayName} · ${a.email.split('@')[0]}` : a.displayName;
}

/**
 * One tab per mailbox, in the top bar while Mail is open. Each mailbox is its own space;
 * there's no combined inbox. Mod+4..9 open them from anywhere.
 */
export function MailboxTabs() {
  const app = useApp();
  const { route, scope, accounts } = app;
  const toast = useToast();
  const [menu, setMenu] = useState<{ anchor: Anchor; items: MenuItem[] } | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [approval, setApproval] = useState<AddAccountResult | null>(null);
  const nav = useRef<HTMLElement>(null);
  const [overflow, setOverflow] = useState({ over: false, atEnd: false });
  const visible = route.view === 'mail' || route.view === 'web';

  // Fade the right edge only when there are more tabs than fit, and not once scrolled to the end.
  useEffect(() => {
    const el = nav.current;
    if (!el) return;
    const measure = () => {
      const over = el.scrollWidth > el.clientWidth + 1;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      setOverflow((o) => (o.over === over && o.atEnd === atEnd ? o : { over, atEnd }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [visible, accounts]);

  const openMailbox = (a: Account) => {
    if (a.kind === 'web') {
      app.navigate({ view: 'web', param: a.id });
      return;
    }
    if (scope.accountId !== a.id) app.setScope({ accountId: a.id, folder: { role: 'inbox' }, tab: 'all' });
    app.navigate({ view: 'mail' });
  };

  // A fixed number of calls in the same order every render, so hooks in a loop are fine.
  for (const n of SLOTS)
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

  const tooltip = (a: Account, i: number) => {
    const lines = [a.displayName, a.email];
    if (a.kind === 'web') lines.push('Outlook on the web');
    if (a.syncState === 'needsAuth') lines.push(`Sign-in needed${a.syncError ? `: ${a.syncError}` : ''}. Right-click to sign in again.`);
    else if (a.syncState === 'error' && a.syncError) lines.push(a.syncError);
    if (a.unread) lines.push(`${a.unread} unread`);
    if (i < SLOTS.length) lines.push(keyLabel(`Mod+${i + 4}`));
    return lines.join('\n');
  };

  const dialogs = (
    <>
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
      {removing && <RemoveAccountDialog account={removing} onClose={() => setRemoving(null)} />}
      {approval && <ApprovalDialog result={approval} onClose={() => setApproval(null)} />}
    </>
  );

  // Only Mail shows the tabs; the shortcuts above work from anywhere.
  if (!visible) return dialogs;

  return (
    <>
      <nav ref={nav} className={`mailbox-tabs${overflow.over ? ' overflowing' : ''}${overflow.atEnd ? ' at-end' : ''}`} aria-label="Mailboxes">
        {accounts.map((a, i) => {
          const selected = isSelected(a);
          const attention = a.syncState === 'needsAuth' ? 'auth' : a.syncState === 'error' ? 'error' : null;
          return (
            <button
              key={a.id}
              type="button"
              className={`mailbox-tab${selected ? ' selected' : ''}`}
              style={{ '--mailbox-color': a.color } as CSSProperties}
              aria-current={selected ? 'page' : undefined}
              ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined}
              title={tooltip(a, i)}
              onClick={() => openMailbox(a)}
              onContextMenu={(e) => accountMenu(e, a)}
            >
              <span className="dot" aria-hidden />
              <span className="name">{tabName(a, accounts)}</span>
              {a.kind === 'web' && <Globe size={12} className="web" aria-label="Outlook on the web" />}
              {attention && (
                <span className={`status ${attention}`} aria-label={attention === 'auth' ? 'Sign-in needed' : 'Sync error'}>
                  !
                </span>
              )}
              {!!a.unread && a.unread > 0 && <span className="count">{badgeText(a.unread)}</span>}
            </button>
          );
        })}
        <button type="button" className="mailbox-tab add" aria-label="Add account" title="Add account" onClick={() => app.openSettings('accounts')}>
          <Plus size={16} />
        </button>
      </nav>
      {dialogs}
    </>
  );
}
