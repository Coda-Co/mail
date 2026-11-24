import { useEffect, useRef } from 'react';
import { AppWindow } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../state/app';

/**
 * A web-only account: Outlook on the web fills the main panel. The desktop
 * shell places the account's isolated native web view over this element's
 * bounds; this placeholder shows underneath (and in browser development).
 */
export function WebAccountView({ accountId }: { accountId: string }) {
  const app = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const account = app.accountById(accountId);
  const exists = account !== undefined;
  const overlayOpen = app.settingsTab !== null;

  // Depend on whether the account exists, not on the account object: the list is
  // replaced on every sync and unread change, and re-running this hides and
  // re-shows the native web view, which flickers.
  useEffect(() => {
    const el = ref.current;
    if (!el || !exists || overlayOpen) {
      api.hideWebAccounts();
      return;
    }
    const report = () => {
      const r = el.getBoundingClientRect();
      api.showWebAccount(accountId, { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      api.hideWebAccounts();
    };
  }, [accountId, exists, overlayOpen]);

  if (!account) {
    return (
      <div className="web-panel">
        <div className="empty-state">
          <span className="body">This account was removed.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="web-panel" ref={ref} aria-label={`${account.displayName} on the web`}>
      <div className="empty-state">
        <AppWindow size={40} strokeWidth={1.5} color="#6E7781" />
        <span className="title">Outlook on the web loads here</span>
        <span className="body">A web view with its own isolated sign-in. It stays loaded in the background, so new mail still shows in the sidebar count and as desktop notifications.</span>
      </div>
    </div>
  );
}
