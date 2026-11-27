import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, EVENTS, onEvent } from '../api';
import type { Account, DiskEncryption, Me, Settings, SyncStatus, UpdateStatus, ViewScope } from '../api/types';

export type View = 'mail' | 'calendar' | 'people' | 'web';

export interface Route {
  view: View;
  /** Web account id, or person email for people. */
  param?: string;
}

export function parseHash(hash: string): Route {
  const [, view = 'mail', ...rest] = hash.replace(/^#/, '').split('/');
  const param = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  if (view === 'calendar' || view === 'people' || view === 'web') return { view, param };
  return { view: 'mail' };
}

export function routeHash(r: Route): string {
  return `#/${r.view}${r.param ? '/' + encodeURIComponent(r.param) : ''}`;
}

interface AppState {
  me: Me;
  accounts: Account[];
  graphAccounts: Account[];
  accountById: (id: string) => Account | undefined;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  sync: SyncStatus;
  disk: DiskEncryption;
  /** App updates: whether a new version is downloading or ready to install. */
  update: UpdateStatus;
  setUpdate: (u: UpdateStatus) => void;
  route: Route;
  navigate: (r: Route) => void;
  scope: ViewScope;
  setScope: (s: ViewScope) => void;
  /** Bumped whenever mail changes; list views refetch on change. */
  mailVersion: number;
  bumpMail: () => void;
  reloadAccounts: () => Promise<void>;
  searchActive: boolean;
  setSearchActive: (v: boolean) => void;
  settingsTab: string | null;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  /** Date the calendar should show (set when clicking through from the agenda). */
  calendarFocus: { date: string; eventId?: string } | null;
  setCalendarFocus: (f: { date: string; eventId?: string } | null) => void;
}

const Ctx = createContext<AppState | null>(null);

const LAST_MAILBOX_KEY = 'mail.lastMailbox';

function lastMailbox(): string | undefined {
  try {
    return localStorage.getItem(LAST_MAILBOX_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_SETTINGS: Settings = { theme: 'light', notifications: true, ctrlF: 'forward', remoteImageSenders: [], remoteImages: 'show', workStart: 9 * 60, workEnd: 18 * 60, spellcheck: true, autocorrect: true, autocapitalize: true, spellingLanguage: 'en-GB', dictionary: [], aiModel: 'openai/gpt-6-luna' };
const DEFAULT_UPDATE: UpdateStatus = { state: 'unavailable', currentVersion: '' };
const DEFAULT_SYNC: SyncStatus = { online: true, syncing: false, label: 'Loading…', outboxHeld: 0 };

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>({ name: '', email: '' });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [sync, setSync] = useState<SyncStatus>(DEFAULT_SYNC);
  const [disk, setDisk] = useState<DiskEncryption>('unknown');
  const [update, setUpdate] = useState<UpdateStatus>(DEFAULT_UPDATE);
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [scope, setScopeState] = useState<ViewScope>({ folder: { role: 'inbox' }, tab: 'all' });
  const [mailVersion, setMailVersion] = useState(0);
  const [searchActive, setSearchActive] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | null>(null);
  const [calendarFocus, setCalendarFocus] = useState<{ date: string; eventId?: string } | null>(null);

  const reloadAccounts = useCallback(async () => setAccounts(await api.listAccounts()), []);
  const bumpMail = useCallback(() => setMailVersion((v) => v + 1), []);

  useEffect(() => {
    api.me().then(setMe);
    reloadAccounts();
    api.getSettings().then(setSettings);
    api.syncStatus().then(setSync);
    api.diskEncryption().then(setDisk);
    api.updateStatus().then(setUpdate);
    const offs = [
      onEvent(EVENTS.mailChanged, () => {
        bumpMail();
        reloadAccounts();
      }),
      onEvent<Account[]>(EVENTS.accountsChanged, (a) => (Array.isArray(a) ? setAccounts(a) : reloadAccounts())),
      onEvent<SyncStatus>(EVENTS.syncStatus, setSync),
      onEvent<UpdateStatus>(EVENTS.updateStatus, setUpdate),
      onEvent<{ accountId: string; unread: number | null }>(EVENTS.webUnread, ({ accountId, unread }) =>
        setAccounts((list) => list.map((a) => (a.id === accountId ? { ...a, unread } : a))),
      ),
    ];
    const net = () => api.syncStatus().then(setSync);
    // Settings can change in another window (a word added to the dictionary in a pop-out).
    const focus = () => api.getSettings().then(setSettings).catch(() => {});
    window.addEventListener('focus', focus);
    window.addEventListener('online', net);
    window.addEventListener('offline', net);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', net);
      window.removeEventListener('offline', net);
    };
  }, [reloadAccounts, bumpMail]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Theme: light, dark, or follow the system.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);

  const navigate = useCallback((r: Route) => {
    const hash = routeHash(r);
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(r);
  }, []);

  const setScope = useCallback((s: ViewScope) => {
    setScopeState(s);
    setSearchActive(false);
  }, []);

  // Each mailbox is its own space: mail always shows one account. Open the
  // last one used, or the first, and move off an account that's gone.
  useEffect(() => {
    const graph = accounts.filter((a) => a.kind === 'graph');
    if (graph.length === 0) return;
    if (scope.accountId && graph.some((a) => a.id === scope.accountId)) return;
    const remembered = lastMailbox();
    const pick = graph.find((a) => a.id === remembered) ?? graph[0];
    setScopeState({ accountId: pick.id, folder: { role: 'inbox' }, tab: 'all' });
  }, [accounts, scope.accountId]);

  useEffect(() => {
    if (!scope.accountId) return;
    try {
      localStorage.setItem(LAST_MAILBOX_KEY, scope.accountId);
    } catch {
      // Not remembered; fine.
    }
  }, [scope.accountId]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await api.updateSettings(patch));
  }, []);

  const value = useMemo<AppState>(
    () => ({
      me,
      accounts,
      graphAccounts: accounts.filter((a) => a.kind === 'graph'),
      accountById: (id: string) => accounts.find((a) => a.id === id),
      settings,
      updateSettings,
      sync,
      disk,
      update,
      setUpdate,
      route,
      navigate,
      scope,
      setScope,
      mailVersion,
      bumpMail,
      reloadAccounts,
      searchActive,
      setSearchActive,
      settingsTab,
      openSettings: (tab = 'general') => setSettingsTab(tab),
      closeSettings: () => setSettingsTab(null),
      calendarFocus,
      setCalendarFocus,
    }),
    [me, accounts, settings, updateSettings, sync, disk, update, route, navigate, scope, setScope, mailVersion, bumpMail, reloadAccounts, searchActive, settingsTab, calendarFocus],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
