import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CloudOff, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { Account } from '../api/types';
import { useApp } from '../state/app';
import { agoTime } from '../lib/dates';
import { now } from '../lib/clock';
import { Popover, useToast } from './ui';

type Tone = 'ok' | 'busy' | 'offline' | 'warn';

/** Re-renders every 30 seconds so "4 min ago" stays true. */
function useTick() {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
}

function accountStatus(a: Account, online: boolean, ref: Date): { tone: Tone; text: string } {
  if (!online) return { tone: 'offline', text: a.lastSyncedAt ? `Offline · last synced ${agoTime(a.lastSyncedAt, ref)}` : 'Offline' };
  switch (a.syncState) {
    case 'syncing':
      return { tone: 'busy', text: 'Syncing…' };
    case 'needsAuth':
      return { tone: 'warn', text: 'Sign in needed' };
    case 'error':
      return { tone: 'warn', text: a.syncError || 'Sync problem' };
    case 'offline':
      return { tone: 'offline', text: 'Can’t reach the server' };
    default:
      return { tone: 'ok', text: a.lastSyncedAt ? `Synced ${agoTime(a.lastSyncedAt, ref)}` : 'Not synced yet' };
  }
}

function ToneIcon({ tone, size = 14 }: { tone: Tone; size?: number }) {
  if (tone === 'busy') return <RefreshCw size={size} className="spin" />;
  if (tone === 'offline') return <CloudOff size={size} />;
  if (tone === 'warn') return <AlertTriangle size={size} />;
  return <Check size={size} />;
}

/** Top-bar summary of sync, with a per-account breakdown on click. */
export function SyncIndicator() {
  const { sync, graphAccounts, openSettings } = useApp();
  const toast = useToast();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useTick();
  const ref = now();

  const anyWarn = graphAccounts.some((a) => a.syncState === 'needsAuth' || a.syncState === 'error');
  const tone: Tone = !sync.online ? 'offline' : sync.syncing ? 'busy' : sync.outboxHeld > 0 || anyWarn ? 'warn' : 'ok';
  // The core's label covers offline, held sends and problems; for the
  // healthy case say when, which is what people want to know.
  const summary = tone === 'ok' && sync.lastSyncedAt && !sync.demo ? `Synced ${agoTime(sync.lastSyncedAt, ref)}` : sync.label;

  // The top bar shows a single dot: green while syncing normally (including mid-sync, so
  // the frequent inbox checks don't make it flicker), orange for problems, grey offline.
  const dot = tone === 'offline' ? 'offline' : tone === 'warn' ? 'warn' : 'ok';

  const syncNow = () => api.syncNow().catch((e) => toast(String(e)));

  return (
    <>
      <button
        type="button"
        className={`sync-indicator dot-${dot}`}
        aria-label={`Sync status: ${summary}`}
        title={summary}
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {sync.demo && (
          <span className="demo-tag" title="Built-in sample data. Nothing here is real or synced. Run pnpm tauri dev for your accounts.">
            Demo data
          </span>
        )}
        <span className="status-dot" aria-hidden="true" />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={320} align="end">
          <div className="sync-panel">
            <div className="sync-panel-head">
              <span className="title">Sync</span>
              <button type="button" className="btn btn-small" onClick={syncNow} disabled={sync.syncing || !sync.online}>
                <RefreshCw size={13} className={sync.syncing ? 'spin' : undefined} />
                {sync.syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
            {graphAccounts.length === 0 && <div className="sync-row-empty">No accounts that sync.</div>}
            {graphAccounts.map((a) => {
              const s = accountStatus(a, sync.online, ref);
              return (
                <div key={a.id} className={`sync-row tone-${s.tone}`}>
                  <span className="acc-dot" style={{ background: a.color }} />
                  <span className="who">
                    <span className="name">{a.displayName}</span>
                    <span className="status" title={a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString() : undefined}>
                      {s.text}
                    </span>
                  </span>
                  {s.tone === 'warn' ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        setAnchor(null);
                        openSettings(`account:${a.id}`);
                      }}
                    >
                      Fix
                    </button>
                  ) : (
                    <span className="icon">
                      <ToneIcon tone={s.tone} size={13} />
                    </span>
                  )}
                </div>
              );
            })}
            {sync.outboxHeld > 0 && (
              <div className="sync-note">
                {sync.outboxHeld === 1 ? '1 message is' : `${sync.outboxHeld} messages are`} held in the outbox. Check Sent before sending again.
              </div>
            )}
            {sync.demo && <div className="sync-note">This is built-in sample data. Nothing here is real or synced; run pnpm tauri dev to use your accounts.</div>}
            {!sync.online && <div className="sync-note">You’re offline. Mail and calendar still work; changes will sync when you reconnect.</div>}
          </div>
        </Popover>
      )}
    </>
  );
}
