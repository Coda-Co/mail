import { useEffect, useRef, useState } from 'react';
import { Bold, ImagePlus, Italic, Link, Palette, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { Account, McpInfo, Signature } from '../api/types';
import { useApp } from '../state/app';
import { Modal, Popover, useToast } from '../components/ui';
import { RichEditor, format, type RichEditorHandle } from '../components/RichEditor';
import { AddAccountForm, AddWebAccountForm, RemoveAccountDialog } from './AccountDialogs';
import { PALETTE } from '../lib/colors';
import { keyLabel } from '../lib/platform';

type Tab = 'general' | 'accounts' | 'signatures' | 'agents';

function GeneralTab() {
  const { settings, updateSettings, disk } = useApp();
  return (
    <>
      <div className="settings-group">
        <h3>Appearance</h3>
        <div className="form-inline">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <label key={t} className="check">
              <input type="radio" name="theme" checked={settings.theme === t} onChange={() => updateSettings({ theme: t })} />
              {t === 'system' ? 'Match system' : t[0].toUpperCase() + t.slice(1)}
            </label>
          ))}
        </div>
      </div>
      <div className="settings-group">
        <h3>Notifications</h3>
        <label className="check">
          <input type="checkbox" checked={settings.notifications} onChange={(e) => updateSettings({ notifications: e.target.checked })} />
          Desktop notifications for new mail and reminders
        </label>
        <span className="hint">Turn them off for single accounts under Accounts.</span>
      </div>
      <div className="settings-group">
        <h3>Keyboard</h3>
        <div className="form-row">
          <label htmlFor="ctrlf">{keyLabel('Mod+F')} in mail</label>
          <select id="ctrlf" className="select" style={{ maxWidth: 260 }} value={settings.ctrlF} onChange={(e) => updateSettings({ ctrlF: e.target.value as 'forward' | 'find' })}>
            <option value="forward">Forward (like Outlook)</option>
            <option value="find">Find in this view</option>
          </select>
        </div>
        <span className="hint">
          {keyLabel('Mod+N')} new · {keyLabel('Mod+R')} reply · {keyLabel('Mod+Shift+R')} reply all · E archive · Delete delete · {keyLabel('Mod+Enter')} send · {keyLabel('Mod+E')} search · Esc close ·{' '}
          {keyLabel('Mod+1')}/{keyLabel('Mod+2')}/{keyLabel('Mod+3')} mail, calendar, people · J/K next, previous
        </span>
      </div>
      <div className="settings-group">
        <h3>Data on this device</h3>
        <span className="hint">
          Mail for Graph accounts is stored on this device so it works offline. Full-disk encryption (BitLocker or FileVault) is{' '}
          <b>{disk === 'on' ? 'on' : disk === 'off' ? 'off' : 'unknown'}</b>.
        </span>
      </div>
    </>
  );
}

function AccountCard({ account, highlight }: { account: Account; highlight: boolean }) {
  const app = useApp();
  const [removing, setRemoving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center' });
  }, [highlight]);
  const patch = async (p: Parameters<typeof api.updateAccount>[1]) => {
    await api.updateAccount(account.id, p);
    await app.reloadAccounts();
  };
  return (
    <div className="account-card" ref={ref} style={highlight ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="top">
        <span className="acc-square" style={{ background: account.color }} />
        <div className="grow">
          <input
            className="input"
            style={{ border: 'none', padding: 0, minHeight: 0, fontWeight: 600, width: '100%' }}
            aria-label="Account name"
            defaultValue={account.displayName}
            onBlur={(e) => e.target.value.trim() && e.target.value !== account.displayName && patch({ displayName: e.target.value.trim() })}
          />
          <div className="email">
            {account.email} · {account.kind === 'web' ? 'Web account' : 'Microsoft Graph'}
            {account.syncState === 'needsAuth' && ' · sign in again'}
            {account.syncState === 'error' && ` · ${account.syncError ?? 'sync error'}`}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${account.displayName}`} onClick={() => setRemoving(true)}>
          <Trash2 size={15} />
        </button>
      </div>
      {account.kind === 'graph' && (
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {PALETTE.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={account.color === c} aria-label={c} className={`swatch${account.color === c ? ' selected' : ''}`} style={{ background: c }} onClick={() => patch({ color: c })} />
          ))}
        </div>
      )}
      <div className="form-inline">
        <label className="check">
          <input type="checkbox" checked={account.notifications} onChange={(e) => patch({ notifications: e.target.checked })} /> Notifications
        </label>
        {account.kind === 'graph' && (
          <>
            <label className="check">
              <input type="checkbox" checked={account.agentsEnabled} onChange={(e) => patch({ agentsEnabled: e.target.checked })} /> Agents can access
            </label>
            <label className="check">
              Keep offline
              <select className="select" value={account.offlineMonths} onChange={(e) => patch({ offlineMonths: Number(e.target.value) })}>
                {[1, 3, 6, 12, 24].map((m) => (
                  <option key={m} value={m}>
                    {m === 1 ? '1 month' : `${m} months`}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {account.kind === 'web' && (
          <button
            type="button"
            className="btn btn-small"
            onClick={async () => {
              const r = await api.upgradeWebAccount(account.id);
              if (r.kind === 'needsAdminApproval') await api.openExternal(r.adminConsentUrl);
              await app.reloadAccounts();
            }}
          >
            Request approval
          </button>
        )}
      </div>
      {removing && <RemoveAccountDialog account={account} onClose={() => setRemoving(false)} />}
    </div>
  );
}

function AccountsTab({ focus }: { focus?: string }) {
  const { accounts } = useApp();
  return (
    <>
      <div className="settings-group">
        <h3>Accounts</h3>
        {accounts.length === 0 && <span className="hint">No accounts yet.</span>}
        {accounts.map((a) => (
          <AccountCard key={a.id} account={a} highlight={a.id === focus} />
        ))}
      </div>
      <div className="settings-group">
        <AddAccountForm onDone={() => {}} />
      </div>
      <div className="settings-group">
        <AddWebAccountForm onDone={() => {}} />
      </div>
    </>
  );
}

function SignatureEditor({ signature, onSaved, onDeleted }: { signature: Signature; onSaved: (s: Signature) => void; onDeleted: () => void }) {
  const [sig, setSig] = useState(signature);
  const [dirty, setDirty] = useState(false);
  const editor = useRef<RichEditorHandle>(null);
  const savedRange = useRef<Range | null>(null);
  const [linkAnchor, setLinkAnchor] = useState<HTMLElement | null>(null);
  const toast = useToast();
  useEffect(() => {
    setSig(signature);
    setDirty(false);
  }, [signature]);
  const set = (p: Partial<Signature>) => {
    setSig((s) => ({ ...s, ...p }));
    setDirty(true);
  };
  const exec = (cmd: string, value?: string) => {
    editor.current?.element()?.focus();
    format(cmd, value);
    const html = editor.current?.element()?.innerHTML ?? sig.html;
    set({ html });
  };
  return (
    <div className="form-row" style={{ gap: 10 }}>
      <div className="form-inline">
        <input className="input" style={{ flex: 1 }} aria-label="Signature name" value={sig.name} onChange={(e) => set({ name: e.target.value })} />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Delete signature"
          onClick={async () => {
            await api.deleteSignature(sig.id);
            onDeleted();
          }}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <div className="signature-editor">
        <div className="editor-toolbar" onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}>
          <button type="button" aria-label="Bold" onClick={() => exec('bold')}>
            <Bold size={15} />
          </button>
          <button type="button" aria-label="Italic" onClick={() => exec('italic')}>
            <Italic size={15} />
          </button>
          <button
            type="button"
            aria-label="Link"
            onClick={(e) => {
              const sel = window.getSelection();
              savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
              setLinkAnchor(e.currentTarget);
            }}
          >
            <Link size={15} />
          </button>
          <label aria-label="Text colour" title="Text colour">
            <Palette size={15} />
            <input type="color" onChange={(e) => exec('foreColor', e.target.value)} />
          </label>
          <label aria-label="Insert logo image" title="Insert logo image">
            <ImagePlus size={15} />
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/svg+xml"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 200_000) {
                  toast('Choose an image under 200 KB for a signature.');
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => exec('insertHTML', `<img src="${reader.result}" alt="" style="max-height:60px">`);
                reader.readAsDataURL(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <RichEditor ref={editor} label="Signature" html={sig.html} onChange={(html) => set({ html })} placeholder="Your signature" />
      </div>
      {linkAnchor && (
        <Popover anchor={linkAnchor} onClose={() => setLinkAnchor(null)} width={300}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const url = new FormData(e.currentTarget).get('url')?.toString().trim();
              setLinkAnchor(null);
              if (!url) return;
              editor.current?.element()?.focus();
              const sel = window.getSelection();
              if (savedRange.current && sel) {
                sel.removeAllRanges();
                sel.addRange(savedRange.current);
              }
              if (sel && sel.isCollapsed) exec('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`);
              else exec('createLink', url);
            }}
          >
            <input name="url" className="menu-input" autoFocus placeholder="https://" aria-label="Link address" defaultValue="https://" />
          </form>
        </Popover>
      )}
      <div className="form-inline">
        <label className="check">
          <input type="checkbox" checked={sig.defaultNew} onChange={(e) => set({ defaultNew: e.target.checked })} /> Default for new messages
        </label>
        <label className="check">
          <input type="checkbox" checked={sig.defaultReply} onChange={(e) => set({ defaultReply: e.target.checked })} /> Default for replies and forwards
        </label>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty}
          onClick={async () => {
            onSaved(await api.saveSignature(sig));
            setDirty(false);
            toast('Signature saved');
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function SignaturesTab() {
  const { graphAccounts } = useApp();
  const [accountId, setAccountId] = useState(graphAccounts[0]?.id ?? '');
  const [sigs, setSigs] = useState<Signature[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const reload = async (keep?: string) => {
    const list = await api.listSignatures(accountId);
    setSigs(list);
    setSelected(keep && list.some((s) => s.id === keep) ? keep : (list[0]?.id ?? null));
  };
  useEffect(() => {
    if (accountId) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);
  const current = sigs.find((s) => s.id === selected);
  return (
    <div className="settings-group">
      <h3>Signatures</h3>
      <span className="hint">Inserted when a draft opens and swapped when you change From. Stored on this device.</span>
      <div className="form-inline">
        <select className="select" aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {graphAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
        <div className="form-inline" style={{ gap: 4 }}>
          {sigs.map((s) => (
            <button key={s.id} type="button" className={`chip${s.id === selected ? ' active' : ''}`} onClick={() => setSelected(s.id)}>
              {s.name}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            onClick={async () => {
              const s = await api.saveSignature({ id: '', accountId, name: 'New signature', html: '<p><br></p>', defaultNew: sigs.length === 0, defaultReply: sigs.length === 0 });
              reload(s.id);
            }}
          >
            + New
          </button>
        </div>
      </div>
      {current ? <SignatureEditor signature={current} onSaved={(s) => reload(s.id)} onDeleted={() => reload()} /> : <span className="hint">No signatures for this account.</span>}
    </div>
  );
}

function AgentsTab() {
  const { settings, updateSettings, graphAccounts, reloadAccounts } = useApp();
  const [info, setInfo] = useState<McpInfo | null>(null);
  const toast = useToast();
  useEffect(() => {
    api.mcpInfo().then(setInfo);
  }, [settings.mcpEnabled]);
  return (
    <>
      <div className="settings-group">
        <h3>Agent access (MCP)</h3>
        <label className="check">
          <input type="checkbox" checked={settings.mcpEnabled} onChange={(e) => updateSettings({ mcpEnabled: e.target.checked })} />
          Let AI agents use a local MCP server
        </label>
        <span className="hint">
          Agents can search mail, read messages and threads, list events, create and update drafts, and create events. <b>Sending is never automatic:</b> agents create drafts; you send them.
        </span>
      </div>
      <div className="settings-group">
        <h3>Accounts agents can use</h3>
        {graphAccounts.map((a) => (
          <label key={a.id} className="check">
            <input
              type="checkbox"
              checked={a.agentsEnabled}
              onChange={async (e) => {
                await api.updateAccount(a.id, { agentsEnabled: e.target.checked });
                reloadAccounts();
              }}
            />
            <span className="acc-dot" style={{ background: a.color }} />
            {a.displayName}
          </label>
        ))}
        <span className="hint">Web accounts can’t be used by agents.</span>
      </div>
      {info && settings.mcpEnabled && (
        <div className="settings-group">
          <h3>Connect a client</h3>
          <span className="hint">Add this to your MCP client’s configuration (for example Claude Desktop or Claude Code):</span>
          <pre className="code-block">{info.configSnippet}</pre>
          <div>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await navigator.clipboard.writeText(info.configSnippet).catch(() => {});
                toast('Configuration copied');
              }}
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function SettingsModal() {
  const app = useApp();
  const raw = app.settingsTab ?? 'general';
  const [tab, setTab] = useState<Tab>(raw.startsWith('account:') ? 'accounts' : (raw as Tab));
  const focus = raw.startsWith('account:') ? raw.slice(8) : undefined;
  const tabs: [Tab, string][] = [
    ['general', 'General'],
    ['accounts', 'Accounts'],
    ['signatures', 'Signatures'],
    ['agents', 'Agents'],
  ];
  return (
    <Modal title="Settings" onClose={app.closeSettings} wide>
      <div className="settings">
        <div className="settings-nav">
          {tabs.map(([t, label]) => (
            <button key={t} type="button" className={`nav-item${tab === t ? ' selected' : ''}`} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        <div className="settings-content">
          {tab === 'general' && <GeneralTab />}
          {tab === 'accounts' && <AccountsTab focus={focus} />}
          {tab === 'signatures' && <SignaturesTab />}
          {tab === 'agents' && <AgentsTab />}
        </div>
      </div>
    </Modal>
  );
}
