import type { ReactNode } from 'react';
import { Calendar, Mail, Settings as Gear, Users } from 'lucide-react';
import { useApp } from '../state/app';
import { keyLabel } from '../lib/platform';
import { useCommand } from '../lib/commands';
import { Avatar } from './ui';

function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

function RailItem({ label, selected, onClick, children }: { label: string; selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className={`rail-item${selected ? ' selected' : ''}`}>
      <button type="button" className="rail-button" aria-label={label} aria-current={selected ? 'page' : undefined} title={label} onClick={onClick}>
        {children}
      </button>
    </div>
  );
}

/**
 * The narrow bar down the left: Mail, Calendar and People, with Settings and you at the
 * bottom. The mailboxes themselves are tabs in the top bar (MailboxTabs).
 */
export function Rail() {
  const app = useApp();
  const { route, scope, accounts, me } = app;

  // Back to the mailbox last open, or the first one.
  const openMail = () => {
    const graph = accounts.find((a) => a.id === scope.accountId) ?? accounts.find((a) => a.kind !== 'web');
    if (graph) {
      if (scope.accountId !== graph.id) app.setScope({ accountId: graph.id, folder: { role: 'inbox' }, tab: 'all' });
      app.navigate({ view: 'mail' });
    } else if (accounts[0]) app.navigate({ view: 'web', param: accounts[0].id });
    else app.openSettings('accounts');
  };
  useCommand('goMail', openMail);
  const unread = accounts.reduce((n, a) => n + (a.unread ?? 0), 0);

  return (
    <nav className="rail" aria-label="Mail, calendar and people">
      <div className="rail-scroll">
        <RailItem label={`Mail${unread ? `\n${unread} unread` : ''}\n${keyLabel('Mod+1')}`} selected={route.view === 'mail' || route.view === 'web'} onClick={openMail}>
          <span className="rail-icon">
            <Mail size={18} />
          </span>
          {unread > 0 && <span className="rail-badge">{badgeText(unread)}</span>}
        </RailItem>
        <RailItem label={`Calendar\n${keyLabel('Mod+2')}`} selected={route.view === 'calendar'} onClick={() => app.navigate({ view: 'calendar' })}>
          <span className="rail-icon">
            <Calendar size={18} />
          </span>
        </RailItem>
        <RailItem label={`People\n${keyLabel('Mod+3')}`} selected={route.view === 'people'} onClick={() => app.navigate({ view: 'people' })}>
          <span className="rail-icon">
            <Users size={18} />
          </span>
        </RailItem>
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
    </nav>
  );
}
