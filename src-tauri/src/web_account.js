// Injected into Outlook on the web (web accounts only). Reports the Inbox unread
// count and forwards web notifications to the app. Best effort: Outlook's markup is
// not an API, so when the count can't be read we report null (the sidebar shows a dot).
(() => {
  if (window.top !== window) return;
  if (!/(^|\.)outlook\.(office|office365|live)\.com$/.test(location.hostname)) return;
  const invoke = (cmd, args) => {
    try {
      const t = window.__TAURI_INTERNALS__;
      if (t && typeof t.invoke === 'function') t.invoke(cmd, args).catch(() => {});
    } catch (_) {}
  };

  // --- unread count
  const num = (s) => {
    const m = String(s || '').match(/(\d[\d,.]*)/);
    return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : NaN;
  };
  function readUnread() {
    const items = document.querySelectorAll('[role="treeitem"], [role="option"], [data-folder-name]');
    for (const el of items) {
      const name = (el.getAttribute('data-folder-name') || el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!/^inbox\b/i.test(name)) continue;
      const label = el.getAttribute('aria-label') || '';
      const viaLabel = label.match(/(\d[\d,.]*)\s+unread/i);
      if (viaLabel) return num(viaLabel[1]);
      const badge = el.querySelector('[class*="unread" i], [class*="count" i], [aria-label*="unread" i]');
      if (badge) {
        const n = num(badge.textContent || badge.getAttribute('aria-label'));
        if (!Number.isNaN(n)) return n;
      }
      return 0;
    }
    // Some builds put "(3)" in the title.
    const t = document.title.match(/\((\d+)\)/);
    if (t) return parseInt(t[1], 10);
    return null;
  }
  let last;
  const tick = () => {
    const n = readUnread();
    if (n !== last) {
      last = n;
      invoke('web_account_report', { unread: n });
    }
  };
  setInterval(tick, 5000);
  document.addEventListener('visibilitychange', tick);

  // --- web notifications → desktop notifications labelled with the account
  function AppNotification(title, options) {
    invoke('web_account_notify', { title: String(title || ''), body: String((options && options.body) || '') });
    this.title = title;
    this.onclick = null;
    this.close = () => {};
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
  }
  AppNotification.permission = 'granted';
  AppNotification.requestPermission = (cb) => {
    if (typeof cb === 'function') cb('granted');
    return Promise.resolve('granted');
  };
  try {
    Object.defineProperty(window, 'Notification', { value: AppNotification, configurable: true, writable: true });
  } catch (_) {
    window.Notification = AppNotification;
  }
})();
