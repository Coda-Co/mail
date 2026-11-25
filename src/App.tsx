import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { AppProvider, useApp } from './state/app';
import { ToastProvider } from './components/ui';
import { Rail } from './components/Rail';
import { SearchSlot, TopBar } from './components/TopBar';
import { MailView } from './views/MailView';
import { CalendarView } from './views/CalendarView';
import { PeopleView } from './views/PeopleView';
import { WebAccountView } from './views/WebAccountView';
import { SettingsModal } from './views/SettingsModal';
import { ComposeWindow, MessageWindow } from './views/PopOutWindows';
import { runCommand, useCommand } from './lib/commands';
import { isBrowserReserved, isTypingTarget, resolveShortcut } from './lib/shortcuts';
import { isMac } from './lib/platform';

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      // Swallow reload keys up front: if reply/reply all has no handler yet
      // (thread still loading), letting them through reloads the whole app.
      if (isBrowserReserved(e, isMac)) e.preventDefault();
      const id = resolveShortcut(e, isTypingTarget(e.target), isMac);
      if (id && runCommand(id)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Shell() {
  const app = useApp();
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  useGlobalShortcuts();
  useCommand('goCalendar', () => app.navigate({ view: 'calendar' }));
  useCommand('goPeople', () => app.navigate({ view: 'people' }));
  // Outside the mail view, mail shortcuts switch to it first. In the mail
  // view these return false so MailView's own handlers run.
  useCommand('search', () => {
    if (app.route.view === 'mail') return false;
    app.navigate({ view: 'mail' });
    app.setSearchActive(true);
  });
  useCommand('newMessage', () => {
    if (app.route.view === 'mail') return false;
    app.navigate({ view: 'mail' });
    setTimeout(() => runCommand('newMessage'), 0);
  });

  const { route } = app;
  return (
    <div className="app">
      <Rail />
      <main className="app-main">
        <TopBar slotRef={setSearchSlot} />
        {!app.sync.online && (
          <div className="banner" style={{ background: 'var(--panel-muted)', borderColor: 'var(--border)' }}>
            <WifiOff size={15} />
            Offline. Mail and calendar still work; changes and sends will go when you reconnect.
          </div>
        )}
        <SearchSlot.Provider value={searchSlot}>
          <div className="app-body">
            {route.view === 'mail' && <MailView />}
            {route.view === 'calendar' && <CalendarView />}
            {route.view === 'people' && <PeopleView />}
            {route.view === 'web' && route.param && <WebAccountView key={route.param} accountId={route.param} />}
          </div>
        </SearchSlot.Provider>
      </main>
      {app.settingsTab && <SettingsModal />}
    </div>
  );
}

function PopOut({ kind, id }: { kind: 'compose' | 'message'; id: string }) {
  useGlobalShortcuts();
  return kind === 'compose' ? <ComposeWindow draftId={id} /> : <MessageWindow messageId={id} />;
}

export function App() {
  const hash = window.location.hash;
  const popout = hash.match(/^#\/(compose|message)\/(.+)$/);
  return (
    <ToastProvider>
      <AppProvider>{popout ? <PopOut kind={popout[1] as 'compose' | 'message'} id={decodeURIComponent(popout[2])} /> : <Shell />}</AppProvider>
    </ToastProvider>
  );
}
