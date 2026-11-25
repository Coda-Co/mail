import { createContext, useContext } from 'react';
import { ArrowDownToLine, Search, SquarePen } from 'lucide-react';
import { api } from '../api';
import { runCommand } from '../lib/commands';
import { useApp } from '../state/app';
import { isMac, keyLabel } from '../lib/platform';
import { SyncIndicator } from './SyncIndicator';

/**
 * The element in the top bar where the mail view puts its live search box
 * while a search is open. Null until the bar has mounted.
 */
export const SearchSlot = createContext<HTMLElement | null>(null);
export const useSearchSlot = () => useContext(SearchSlot);

/**
 * The bar across the top of the main area. Search lives here and follows the
 * view: mail search in Mail, people in People, events in Calendar (those views
 * put their own box in the slot).
 */
export function TopBar({ slotRef }: { slotRef: (el: HTMLDivElement | null) => void }) {
  const app = useApp();
  const { view } = app.route;
  // People and Calendar put their own search box in the slot.
  const showTrigger = (view === 'mail' && !app.searchActive) || view === 'web';
  return (
    <header className="topbar">
      <div className="topbar-search" ref={slotRef}>
        {showTrigger && (
          <button
            type="button"
            className="search-trigger"
            onClick={() => {
              if (app.route.view !== 'mail') app.navigate({ view: 'mail' });
              app.setSearchActive(true);
            }}
          >
            <Search size={15} />
            <span className="label">Search mail</span>
            <span className="kbd-hint">{keyLabel('Mod+E')}</span>
          </button>
        )}
      </div>
      <span className="spacer" />
      <UpdateButton />
      <SyncIndicator />
      <button
        type="button"
        className="btn btn-ghost btn-icon topbar-new"
        onClick={() => runCommand('newMessage')}
        title={`New email (${keyLabel('Mod+N')})`}
        aria-label="New email"
      >
        <SquarePen size={18} />
      </button>
    </header>
  );
}

/** Shown once a new version has downloaded; installs it and relaunches. */
function UpdateButton() {
  const { update } = useApp();
  if (update.state !== 'ready' && update.state !== 'installing') return null;
  const installing = update.state === 'installing';
  return (
    <button
      type="button"
      className="btn btn-ghost btn-small"
      disabled={installing}
      onClick={() => api.installUpdate()}
      title={installing ? undefined : `Mail ${update.version} is ready${isMac ? '. It also installs the next time you quit.' : ''}`}
    >
      <ArrowDownToLine size={14} />
      {installing ? 'Updating…' : 'Restart to update'}
    </button>
  );
}
