import { useState } from 'react';
import { ShieldCheck, Copy, Globe } from 'lucide-react';
import { api } from '../api';
import type { Account, AddAccountResult } from '../api/types';
import { useApp } from '../state/app';
import { Modal, useToast } from '../components/ui';

export function RemoveAccountDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Remove ${account.displayName}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.removeAccount(account.id);
              await app.reloadAccounts();
              if (app.scope.accountId === account.id) app.setScope({ folder: { role: 'inbox' }, tab: 'all' });
              if (app.route.param === account.id) app.navigate({ view: 'mail' });
              toast(`${account.displayName} removed`);
              onClose();
            }}
          >
            Remove
          </button>
        </>
      }
    >
      <div className="modal-body">
        <p className="hint" style={{ margin: 0 }}>
          {account.kind === 'web'
            ? 'This clears the web view’s sign-in and stored data on this device.'
            : 'This deletes the account’s mail, calendar and cache from this device and removes its sign-in. Nothing is deleted from the server.'}
        </p>
      </div>
    </Modal>
  );
}

/** The three choices offered when a tenant needs admin approval (SPEC §2). */
export function ApprovalDialog({ result, onClose, onWebMode }: { result: AddAccountResult; onClose: () => void; onWebMode?: () => void }) {
  const toast = useToast();
  const app = useApp();
  if (result.kind !== 'needsAdminApproval') {
    return (
      <Modal title="Account" onClose={onClose}>
        <div className="modal-body">
          <p className="hint" style={{ margin: 0 }}>
            {result.kind === 'added' ? `${result.account.displayName} is ready.` : result.kind === 'error' ? result.message : 'Cancelled.'}
          </p>
        </div>
      </Modal>
    );
  }
  const domain = result.email.split('@')[1];
  const alreadyWeb = app.accounts.some((a) => a.email.toLowerCase() === result.email.toLowerCase() && a.kind === 'web');
  return (
    <Modal title="Needs admin approval" onClose={onClose}>
      <div className="modal-body">
        <p className="hint" style={{ margin: 0 }}>
          {domain} only lets apps its admins have approved read your mail. Microsoft returned {result.errorCode}.
        </p>
        <button
          type="button"
          className="account-card"
          style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--bg)' }}
          onClick={() => api.openExternal(result.adminConsentUrl)}
        >
          <span className="top">
            <ShieldCheck size={18} />
            <span className="grow">
              <b>I’m an admin</b>
              <div className="email">Open the approval page for {domain} in your browser, then add the account again.</div>
            </span>
          </span>
        </button>
        <button
          type="button"
          className="account-card"
          style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--bg)' }}
          onClick={async () => {
            await navigator.clipboard.writeText(result.requestMessage).catch(() => {});
            toast('Request copied. Paste it into a message to your admin.');
          }}
        >
          <span className="top">
            <Copy size={18} />
            <span className="grow">
              <b>Ask my admin</b>
              <div className="email">Copy a short request with the approval link and our security note.</div>
            </span>
          </span>
        </button>
        {!alreadyWeb && (
          <button
            type="button"
            className="account-card"
            style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--bg)' }}
            onClick={async () => {
              const name = domain.split('.')[0].replace(/^\w/, (c) => c.toUpperCase());
              const acc = await api.addWebAccount(result.email, name);
              await app.reloadAccounts();
              onClose();
              onWebMode?.();
              app.navigate({ view: 'web', param: acc.id });
            }}
          >
            <span className="top">
              <Globe size={18} />
              <span className="grow">
                <b>Use web mode for now</b>
                <div className="email">Outlook on the web inside the app. No offline mail; you can upgrade later.</div>
              </span>
            </span>
          </button>
        )}
      </div>
    </Modal>
  );
}

export function AddAccountForm({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<AddAccountResult | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.addAccount(email.trim());
      if (r.kind === 'added') {
        await app.reloadAccounts();
        toast(`${r.account.displayName} added. Syncing…`);
        setEmail('');
        onDone();
      } else if (r.kind === 'needsAdminApproval') setApproval(r);
      else if (r.kind === 'error') setError(r.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-row">
      <label htmlFor="add-email">Add a Microsoft 365 account</label>
      <form
        className="form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input id="add-email" className="input" style={{ flex: 1, minWidth: 220 }} type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={busy || !email.includes('@')}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <span className="hint">Sign-in opens in your browser. If the organisation blocks third-party apps, you’ll be offered other options.</span>
      {error && <span className="error-text">{error}</span>}
      {approval && <ApprovalDialog result={approval} onClose={() => setApproval(null)} onWebMode={onDone} />}
    </div>
  );
}

export function AddWebAccountForm({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  return (
    <div className="form-row">
      <label htmlFor="web-email">Add a web-only account</label>
      <form
        className="form-inline"
        onSubmit={async (e) => {
          e.preventDefault();
          const acc = await api.addWebAccount(email.trim(), name.trim() || email.split('@')[1]?.split('.')[0] || email);
          await app.reloadAccounts();
          setEmail('');
          setName('');
          onDone();
          app.navigate({ view: 'web', param: acc.id });
        }}
      >
        <input id="web-email" className="input" style={{ flex: 1, minWidth: 180 }} type="email" placeholder="you@client.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" style={{ width: 160 }} placeholder="Name (e.g. client)" aria-label="Display name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn" disabled={!email.includes('@')}>
          Add
        </button>
      </form>
      <span className="hint">Outlook on the web in its own isolated web view. Use this for tenants that block third-party apps.</span>
    </div>
  );
}
