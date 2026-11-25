// In-memory MailApi for browser development, screenshots and tests.
// State persists in localStorage so pop-out windows see the same drafts.

import type {
  Account,
  AddAccountResult,
  AgendaDay,
  CalendarEvent,
  Draft,
  DraftMode,
  EventInput,
  Folder,
  MailApi,
  Message,
  MessageSummary,
  Person,
  SearchQuery,
  SearchField,
  SearchResult,
  Signature,
  SyncStatus,
  UpdateStatus,
  ViewScope,
} from './types';
import { EVENTS } from './types';
import { buildDemoState, DEMO_VERSION, type DemoState } from './demoData';
import { emit } from './emitter';
import { demoNow, now } from '../lib/clock';
import { addDays, dayName, fullTime, startOfDay } from '../lib/dates';
import { escapeHtml, htmlToText } from '../lib/text';
import { PALETTE, WEB_ONLY } from '../lib/colors';

const STORAGE_KEY = 'mail-demo-state';
const hasWindow = typeof window !== 'undefined';

let state: DemoState = load();
const shownOnce = new Set<string>();
// Persist the seed so pop-out windows open on the same data.
if (hasWindow && !localStorage.getItem(STORAGE_KEY)) save();

function load(): DemoState {
  if (hasWindow) {
    try {
      if (new URLSearchParams(window.location.search).has('reset')) localStorage.removeItem(STORAGE_KEY);
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DemoState;
        if (parsed.version === DEMO_VERSION) {
          // Settings added since this state was saved take their defaults.
          parsed.settings = { ...parsed.settings, remoteImages: parsed.settings.remoteImages ?? 'show' };
          return recount(parsed);
        }
      }
    } catch {
      /* storage unavailable: start fresh */
    }
  }
  return recount(buildDemoState(demoNow()));
}

function save(): void {
  recount(state);
  if (!hasWindow) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

if (hasWindow) {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      state = JSON.parse(e.newValue) as DemoState;
      emit(EVENTS.mailChanged, { accountIds: state.accounts.map((a) => a.id) });
      emit(EVENTS.accountsChanged, state.accounts);
      state.drafts.forEach((d) => emit(EVENTS.draftChanged, { draftId: d.id }));
      emit(EVENTS.draftDocked, { draftId: '*' });
    } catch {
      /* ignore */
    }
  });
}

/** Reset to the seed data (tests and "Reset demo data"). */
export function resetDemo(): void {
  state = recount(buildDemoState(demoNow()));
  shownOnce.clear();
  save();
}

function recount(s: DemoState): DemoState {
  for (const f of s.folders) {
    if (f.role === 'drafts') {
      const n = s.drafts.filter((d) => d.accountId === f.accountId && d.status !== 'sent').length;
      f.total = n;
      f.unread = 0;
      continue;
    }
    const msgs = s.messages.filter((m) => m.folderId === f.id);
    f.total = msgs.length;
    f.unread = msgs.filter((m) => !m.isRead).length;
  }
  for (const a of s.accounts) {
    if (a.kind !== 'graph') continue;
    const inbox = s.folders.find((f) => f.accountId === a.id && f.role === 'inbox');
    a.unread = inbox ? inbox.unread : 0;
  }
  return s;
}

const changed = (accountIds: string[]) => {
  save();
  emit(EVENTS.mailChanged, { accountIds });
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function account(id: string): Account {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown account ${id}`);
  return a;
}

function folderOf(accountId: string, role: string): Folder | undefined {
  return state.folders.find((f) => f.accountId === accountId && f.role === role);
}

function myAddress(accountId: string) {
  const a = account(accountId);
  return { name: state.me.name, email: a.email };
}

const isMe = (email: string) => state.accounts.some((a) => a.email.toLowerCase() === email.toLowerCase());

const graphIds = () => state.accounts.filter((a) => a.kind === 'graph').map((a) => a.id);

function summary(m: Message): MessageSummary {
  const { id, accountId, folderId, conversationId, from, to, subject, snippet, receivedAt, isRead, isFlagged, hasAttachments, isDraft } = m;
  const hasDraft = !isDraft && state.drafts.some((d) => d.conversationId === conversationId && d.edited !== false && (d.status === 'editing' || d.status === 'failed'));
  return { id, accountId, folderId, conversationId, from, to, subject, snippet, receivedAt, isRead, isFlagged, hasAttachments, isDraft, hasDraft };
}

function draftSummary(d: Draft): MessageSummary {
  return {
    id: d.id,
    accountId: d.accountId,
    folderId: folderOf(d.accountId, 'drafts')?.id ?? '',
    conversationId: d.conversationId ?? d.id,
    from: myAddress(d.accountId),
    to: d.to,
    subject: d.subject || '(no subject)',
    snippet: htmlToText(stripSignature(d.bodyHtml)).slice(0, 140) || 'No text',
    receivedAt: d.updatedAt,
    isRead: true,
    isFlagged: false,
    hasAttachments: d.attachments.length > 0,
    isDraft: true,
  };
}

const REMOTE_IMG = /<img\b[^>]*\bsrc=["']https?:[^"']*["'][^>]*>/gi;

function view(m: Message): Message {
  const inJunk = state.folders.some((f) => f.id === m.folderId && f.role === 'junk');
  const showByDefault = state.settings.remoteImages === 'show' && !inJunk;
  const allowed = showByDefault || state.settings.remoteImageSenders.includes(m.from.email.toLowerCase()) || shownOnce.has(m.id);
  const hasRemote = REMOTE_IMG.test(m.bodyHtml);
  REMOTE_IMG.lastIndex = 0;
  const out: Message = !hasRemote || allowed ? { ...clone(m), remoteImagesBlocked: false } : { ...clone(m), bodyHtml: m.bodyHtml.replace(REMOTE_IMG, ''), remoteImagesBlocked: true };
  // The calendar's copy of a meeting message's event, as the core does.
  if (out.meeting?.eventId) {
    const e = state.events.find((x) => x.id === out.meeting!.eventId);
    out.meeting.event = e ? clone(e) : undefined;
  }
  return out;
}

function getMsg(id: string): Message {
  const m = state.messages.find((x) => x.id === id) ?? state.serverOnly.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown message ${id}`);
  return m;
}

function inScope(m: { accountId: string; folderId: string }, scope: ViewScope): boolean {
  const accounts = scope.accountId ? [scope.accountId] : graphIds();
  if (!accounts.includes(m.accountId)) return false;
  if ('id' in scope.folder) return m.folderId === scope.folder.id;
  const role = scope.folder.role;
  return state.folders.some((f) => f.id === m.folderId && f.role === role);
}

// ---- Signatures in draft bodies ----------------------------------------

const SIG_RE = /<div data-signature="[^"]*">[\s\S]*<\/div>\s*$/;

function stripSignature(html: string): string {
  if (hasWindow && typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    doc.querySelectorAll('[data-signature]').forEach((n) => n.remove());
    return doc.body.innerHTML;
  }
  return html.replace(SIG_RE, '');
}

function signatureFor(accountId: string, mode: DraftMode): Signature | undefined {
  const sigs = state.signatures.filter((s) => s.accountId === accountId);
  return mode === 'new' ? sigs.find((s) => s.defaultNew) : sigs.find((s) => s.defaultReply);
}

function withSignature(body: string, sig: Signature | undefined): string {
  const base = stripSignature(body) || '<p><br></p>';
  if (!sig) return base;
  return `${base}<div data-signature="${sig.id}"><p><br></p>${sig.html}</div>`;
}

// ---- People --------------------------------------------------------------

function people(): Person[] {
  const map = new Map<string, Person & { _score: number }>();
  const ref = now().getTime();
  for (const m of state.messages) {
    const sent = m.folderId.endsWith('-sent') || isMe(m.from.email);
    const others = sent ? [...m.to, ...m.cc] : [m.from, ...m.cc];
    for (const a of others) {
      if (!a.email || isMe(a.email)) continue;
      const key = a.email.toLowerCase();
      let p = map.get(key);
      if (!p) {
        p = { email: a.email, name: a.name || a.email, accountIds: [], messageCount: 0, lastContactAt: m.receivedAt, score: 0, _score: 0 };
        map.set(key, p);
      }
      p.messageCount++;
      if (!p.accountIds.includes(m.accountId)) p.accountIds.push(m.accountId);
      if (m.receivedAt > p.lastContactAt) p.lastContactAt = m.receivedAt;
      const ageDays = Math.max(0, (ref - new Date(m.receivedAt).getTime()) / 86400000);
      // Recent and frequent correspondence ranks highest; mail I sent counts double.
      p._score += (sent ? 2 : 1) / (1 + ageDays / 14);
    }
  }
  return [...map.values()]
    .map(({ _score, ...p }) => ({ ...p, score: Math.round(_score * 100) / 100 }))
    .sort((a, b) => b.score - a.score);
}

// ---- Search --------------------------------------------------------------

function matchText(m: Message, text: string, field: SearchField = 'all'): boolean {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const sender = [m.from.name, m.from.email];
  const recipients = [...m.to, ...m.cc].flatMap((a) => [a.name, a.email]);
  const content = [m.subject, m.snippet, htmlToText(m.bodyHtml)];
  const parts =
    field === 'from'
      ? sender
      : field === 'to'
        ? recipients
        : field === 'subject'
          ? [m.subject]
          : field === 'content'
            ? content
            : [...content, ...sender, ...recipients, ...m.attachments.map((a) => a.name)];
  const hay = parts.join(' ').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function runSearch(q: SearchQuery, pool: Message[]): MessageSummary[] {
  const ref = now();
  const windowDays = { any: 0, week: 7, month: 31, year: 366 }[q.date ?? 'any'];
  const accounts = q.accountId ? [q.accountId] : q.scope.accountId ? [q.scope.accountId] : graphIds();
  return pool
    .filter((m) => accounts.includes(m.accountId))
    .filter((m) => {
      if (!q.allFolders) return inScope(m, { ...q.scope, accountId: undefined, tab: 'all' });
      const f = state.folders.find((x) => x.id === m.folderId);
      return !f || (f.role !== 'deleted' && f.role !== 'junk');
    })
    .filter((m) => (q.scope.tab === 'unread' ? !m.isRead : q.scope.tab === 'flagged' ? m.isFlagged : true))
    .filter((m) => !q.from || m.from.email.toLowerCase() === q.from.toLowerCase())
    .filter((m) => !q.to || [...m.to, ...m.cc].some((a) => a.email.toLowerCase() === q.to!.toLowerCase()))
    .filter((m) => !q.hasAttachment || m.hasAttachments)
    .filter((m) => !q.unread || !m.isRead)
    .filter((m) => !windowDays || ref.getTime() - new Date(m.receivedAt).getTime() <= windowDays * 86400000)
    .filter((m) => matchText(m, q.text, q.field))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .map(summary);
}

// ---- Calendar ------------------------------------------------------------

function visibleEvents(): CalendarEvent[] {
  const visible = new Set(state.calendars.filter((c) => c.visible).map((c) => c.id));
  return state.events.filter((e) => visible.has(e.calendarId) && !e.isCancelled);
}

function eventFromInput(input: EventInput, existing?: CalendarEvent): CalendarEvent {
  const acc = account(input.accountId);
  const cal = state.calendars.find((c) => c.id === input.calendarId) ?? state.calendars.find((c) => c.accountId === acc.id && c.isDefault);
  const me = myAddress(acc.id);
  return {
    id: existing?.id ?? `evt-${Math.random().toString(36).slice(2, 9)}`,
    accountId: acc.id,
    calendarId: cal?.id ?? '',
    subject: input.subject || '(no title)',
    start: input.start,
    end: input.end,
    isAllDay: input.isAllDay,
    location: input.location,
    bodyHtml: input.bodyHtml,
    organizer: existing?.organizer ?? me,
    attendees: input.attendees.map((a) => ({
      address: a,
      type: 'required',
      response: existing?.attendees.find((x) => x.address.email === a.email)?.response ?? 'none',
    })),
    myResponse: existing?.myResponse ?? 'organizer',
    isOnlineMeeting: input.isOnlineMeeting,
    onlineMeetingUrl: input.isOnlineMeeting ? (existing?.onlineMeetingUrl ?? 'https://teams.example/meet/new') : undefined,
    reminderMinutes: input.reminderMinutes,
    isCancelled: false,
    color: acc.color,
    readOnly: false,
  };
}

const READ_ONLY = 'This event is read-only. Change it in Outlook on the web.';

function editableEvent(eventId: string): CalendarEvent {
  const e = state.events.find((x) => x.id === eventId);
  if (!e) throw new Error('Unknown event');
  if (e.readOnly) throw new Error(READ_ONLY);
  return e;
}

// ---- Accounts -------------------------------------------------------------

function newAccount(email: string, kind: 'graph' | 'web', displayName?: string): Account {
  const used = new Set(state.accounts.map((a) => a.color));
  const color = kind === 'web' ? WEB_ONLY : (PALETTE.find((c) => !used.has(c)) ?? PALETTE[state.accounts.length % PALETTE.length]);
  const domain = email.split('@')[1] ?? 'example';
  const name = displayName || domain.split('.')[0].replace(/^\w/, (c) => c.toUpperCase());
  const a: Account = {
    id: `acc-${Math.random().toString(36).slice(2, 8)}`,
    email,
    displayName: name,
    kind,
    color,
    unread: kind === 'web' ? null : 0,
    notifications: true,
    offlineMonths: kind === 'web' ? 0 : 6,
    syncState: 'idle',
    lastSyncedAt: kind === 'graph' ? now().toISOString() : undefined,
    webUrl: kind === 'web' ? 'https://outlook.office.com/mail/' : undefined,
    webCalendar: false,
  };
  state.accounts.push(a);
  if (kind === 'graph') {
    for (const [role, n] of [['inbox', 'Inbox'], ['drafts', 'Drafts'], ['sent', 'Sent'], ['archive', 'Archive'], ['deleted', 'Deleted']] as const) {
      state.folders.push({ id: `${a.id}-${role}`, accountId: a.id, name: n, role, unread: 0, total: 0 });
    }
    state.calendars.push({ id: `cal-${a.id}`, accountId: a.id, name: 'Calendar', color, visible: true, isDefault: true, readOnly: false });
  }
  return a;
}

function needsApproval(email: string): AddAccountResult {
  const domain = email.split('@')[1] ?? '';
  const url = `https://login.microsoftonline.com/${domain || 'organizations'}/adminconsent?client_id=00000000-0000-0000-0000-000000000000`;
  return {
    kind: 'needsAdminApproval',
    email,
    tenantId: domain,
    errorCode: 'AADSTS90094',
    adminConsentUrl: url,
    requestMessage:
      `Hi,\n\nI'd like to use Mail (a desktop mail and calendar app from Coda & Co) with my ${domain} account. ` +
      `It needs admin approval before I can sign in. It asks only for delegated access to my own mail and calendar ` +
      `(Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, User.Read, offline_access).\n\n` +
      `Approve it here: ${url}\n\nWhat it requests, where data lives and how to revoke: https://coda.example/mail/security\n\nThanks`,
  };
}

// ---- Drafts ----------------------------------------------------------------

function getDraftState(id: string): Draft {
  const d = state.drafts.find((x) => x.id === id);
  if (!d) throw new Error(`Unknown draft ${id}`);
  return d;
}

function prefixed(prefix: string, subject: string): string {
  const re = new RegExp(`^${prefix}:\\s`, 'i');
  return re.test(subject) ? subject : `${prefix.toUpperCase()}: ${subject}`;
}

function forwardBody(m: Message): string {
  return (
    `<p><br></p><div data-forwarded><hr><p><b>From:</b> ${escapeHtml(m.from.name)} &lt;${escapeHtml(m.from.email)}&gt;<br>` +
    `<b>Sent:</b> ${escapeHtml(fullTime(m.receivedAt))}<br><b>Subject:</b> ${escapeHtml(m.subject)}</p>${m.bodyHtml}</div>`
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- API -------------------------------------------------------------------

export const demoApi: MailApi = {
  async me() {
    return clone(state.me);
  },
  async listAccounts() {
    return clone(state.accounts);
  },
  async addAccount(email) {
    await sleep(400);
    const lower = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lower)) return { kind: 'error', message: 'Enter a full email address.' };
    if (state.accounts.some((a) => a.email.toLowerCase() === lower)) return { kind: 'error', message: 'That account is already added.' };
    // Demo rule: tenants with "client" or "blocked" in the domain need admin approval.
    if (/client|blocked|aldgate/.test(lower.split('@')[1])) return needsApproval(lower);
    const a = newAccount(lower, 'graph');
    save();
    emit(EVENTS.accountsChanged, state.accounts);
    return { kind: 'added', account: clone(a) };
  },
  async addWebAccount(email, displayName) {
    const a = newAccount(email.trim().toLowerCase(), 'web', displayName);
    save();
    emit(EVENTS.accountsChanged, state.accounts);
    return clone(a);
  },
  async upgradeWebAccount(accountId) {
    return needsApproval(account(accountId).email);
  },
  async updateAccount(accountId, patch) {
    const a = account(accountId);
    if (patch.webCalendar !== undefined && patch.webCalendar !== a.webCalendar) {
      if (a.kind !== 'web') throw new Error('Only web accounts read their calendar from Outlook on the web');
      if (patch.webCalendar) {
        // The demo has no Outlook page to read: bring back the sample events.
        const seed = buildDemoState(demoNow());
        state.calendars.push(...seed.calendars.filter((c) => c.accountId === accountId));
        state.events.push(...seed.events.filter((e) => e.accountId === accountId));
        a.webCalendarSyncedAt = now().toISOString();
      } else {
        // Turning it off deletes everything read from Outlook on the web straight away.
        state.calendars = state.calendars.filter((c) => c.accountId !== accountId);
        state.events = state.events.filter((e) => e.accountId !== accountId);
        a.webCalendarSyncedAt = undefined;
        a.webCalendarError = undefined;
      }
    }
    Object.assign(a, patch);
    if (patch.color) {
      state.calendars.filter((c) => c.accountId === accountId).forEach((c) => (c.color = patch.color!));
      state.events.filter((e) => e.accountId === accountId).forEach((e) => (e.color = patch.color!));
    }
    save();
    if (patch.webCalendar !== undefined) emit(EVENTS.mailChanged, { accountIds: [accountId] });
    emit(EVENTS.accountsChanged, state.accounts);
    return clone(a);
  },
  async removeAccount(accountId) {
    state.accounts = state.accounts.filter((a) => a.id !== accountId);
    state.folders = state.folders.filter((f) => f.accountId !== accountId);
    state.messages = state.messages.filter((m) => m.accountId !== accountId);
    state.drafts = state.drafts.filter((d) => d.accountId !== accountId);
    state.calendars = state.calendars.filter((c) => c.accountId !== accountId);
    state.events = state.events.filter((e) => e.accountId !== accountId);
    state.signatures = state.signatures.filter((s) => s.accountId !== accountId);
    save();
    emit(EVENTS.accountsChanged, state.accounts);
    emit(EVENTS.mailChanged, { accountIds: [accountId] });
  },

  async listFolders(accountId) {
    return clone(state.folders.filter((f) => (accountId ? f.accountId === accountId : graphIds().includes(f.accountId))));
  },
  async listMessages(scope, limit, offset) {
    const isDrafts = !('id' in scope.folder) && scope.folder.role === 'drafts';
    const draftFolder = 'id' in scope.folder ? state.folders.find((f) => f.id === (scope.folder as { id: string }).id) : undefined;
    let list: MessageSummary[];
    if (isDrafts || draftFolder?.role === 'drafts') {
      const accounts = scope.accountId ? [scope.accountId] : graphIds();
      list = state.drafts.filter((d) => accounts.includes(d.accountId) && d.status !== 'sent').map(draftSummary);
    } else {
      list = state.messages.filter((m) => inScope(m, scope)).map(summary);
    }
    if (scope.tab === 'unread') list = list.filter((m) => !m.isRead);
    if (scope.tab === 'flagged') list = list.filter((m) => m.isFlagged);
    list.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return list.slice(offset, offset + limit);
  },
  async getThread(messageId) {
    const m = getMsg(messageId);
    const messages = state.messages
      .filter((x) => x.conversationId === m.conversationId && !x.folderId.endsWith('-deleted'))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map(view);
    if (!messages.some((x) => x.id === m.id)) messages.unshift(view(m));
    const drafts = state.drafts.filter((d) => d.conversationId === m.conversationId && d.status !== 'sent');
    return { conversationId: m.conversationId, subject: m.subject, messages, drafts: clone(drafts) };
  },
  async getMessage(messageId) {
    return view(getMsg(messageId));
  },
  async markRead(ids, read) {
    const accs = new Set<string>();
    state.messages.filter((m) => ids.includes(m.id)).forEach((m) => {
      m.isRead = read;
      accs.add(m.accountId);
    });
    changed([...accs]);
  },
  async setFlag(ids, flagged) {
    const accs = new Set<string>();
    state.messages.filter((m) => ids.includes(m.id)).forEach((m) => {
      m.isFlagged = flagged;
      accs.add(m.accountId);
    });
    changed([...accs]);
  },
  async archive(ids) {
    const accs = new Set<string>();
    state.messages.filter((m) => ids.includes(m.id)).forEach((m) => {
      const f = folderOf(m.accountId, 'archive');
      if (f) m.folderId = f.id;
      accs.add(m.accountId);
    });
    changed([...accs]);
  },
  async deleteMessages(ids) {
    const accs = new Set<string>();
    for (const id of ids) {
      const draft = state.drafts.find((d) => d.id === id);
      if (draft) {
        state.drafts = state.drafts.filter((d) => d.id !== id);
        accs.add(draft.accountId);
        continue;
      }
      const m = state.messages.find((x) => x.id === id);
      if (!m) continue;
      accs.add(m.accountId);
      const deleted = folderOf(m.accountId, 'deleted');
      if (!deleted || m.folderId === deleted.id) state.messages = state.messages.filter((x) => x.id !== id);
      else m.folderId = deleted.id;
    }
    changed([...accs]);
  },
  async moveMessages(ids, folderId) {
    const accs = new Set<string>();
    state.messages.filter((m) => ids.includes(m.id)).forEach((m) => {
      m.folderId = folderId;
      accs.add(m.accountId);
    });
    changed([...accs]);
  },
  async allowRemoteImages(senderEmail) {
    const e = senderEmail.toLowerCase();
    if (!state.settings.remoteImageSenders.includes(e)) state.settings.remoteImageSenders.push(e);
    save();
  },
  async showRemoteImagesOnce(messageId) {
    shownOnce.add(messageId);
    return view(getMsg(messageId));
  },
  async openAttachment() {
    /* The desktop app opens the cached file with the system viewer. */
  },
  async copyAttachments() {
    /* The desktop app puts the cached files on the system clipboard. */
  },

  async createDraft(req) {
    const source = req.sourceMessageId ? getMsg(req.sourceMessageId) : undefined;
    const accountId =
      source?.accountId ?? (req.accountId && account(req.accountId).kind === 'graph' ? req.accountId : graphIds()[0]);
    const me = myAddress(accountId);
    let to: Draft['to'] = [];
    let cc: Draft['cc'] = [];
    let subject = '';
    let body = '';
    if (source && req.mode !== 'new') {
      const fromMe = isMe(source.from.email);
      if (req.mode === 'reply') to = fromMe ? source.to : [source.from];
      if (req.mode === 'replyAll') {
        to = (fromMe ? source.to : [source.from, ...source.to]).filter((a) => a.email !== me.email);
        cc = source.cc.filter((a) => a.email !== me.email && !to.some((t) => t.email === a.email));
      }
      subject = req.mode === 'forward' ? prefixed('Fw', source.subject) : prefixed('Re', source.subject);
      if (req.mode === 'forward') body = forwardBody(source);
    }
    const sig = signatureFor(accountId, req.mode);
    const draft: Draft = {
      id: `draft-${Math.random().toString(36).slice(2, 9)}`,
      accountId,
      mode: req.mode,
      sourceMessageId: source?.id,
      conversationId: source?.conversationId,
      to: clone(to),
      cc: clone(cc),
      bcc: [],
      subject,
      bodyHtml: '',
      signatureId: sig?.id,
      attachments: req.mode === 'forward' && source ? clone(source.attachments) : [],
      updatedAt: now().toISOString(),
      savedToServer: false,
      status: 'editing',
      poppedOut: false,
      edited: false,
    };
    if (req.mode === 'forward') {
      draft.bodyHtml = sig ? withSignature('<p><br></p>', sig) + body.replace(/^<p><br><\/p>/, '') : body;
    } else {
      draft.bodyHtml = sig ? withSignature('', sig) : '';
    }
    state.drafts.push(draft);
    changed([accountId]);
    return clone(draft);
  },
  async getDraft(draftId) {
    return clone(getDraftState(draftId));
  },
  async updateDraft(draft) {
    const existing = getDraftState(draft.id);
    const { accountId, poppedOut, status } = existing;
    const firstEdit = existing.edited === false;
    Object.assign(existing, clone(draft), { accountId, poppedOut, status, edited: true, updatedAt: now().toISOString(), savedToServer: true });
    save();
    emit(EVENTS.draftChanged, { draftId: draft.id });
    // The conversation's row now shows it has a draft.
    if (firstEdit) changed([accountId]);
    return clone(existing);
  },
  async changeDraftAccount(draftId, accountId) {
    const d = getDraftState(draftId);
    if (account(accountId).kind !== 'graph') throw new Error('Web accounts cannot send from the app.');
    d.accountId = accountId;
    const sig = signatureFor(accountId, d.mode);
    d.signatureId = sig?.id;
    d.bodyHtml = withSignature(d.bodyHtml, sig);
    d.edited = true;
    d.updatedAt = now().toISOString();
    changed([accountId]);
    emit(EVENTS.draftChanged, { draftId });
    return clone(d);
  },
  async addAttachment(draftId) {
    const d = getDraftState(draftId);
    if (!hasWindow) return clone(d);
    const files = await new Promise<FileList | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = () => resolve(input.files);
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
    for (const f of Array.from(files ?? [])) {
      d.attachments.push({ id: `att-${Math.random().toString(36).slice(2, 9)}`, name: f.name, contentType: f.type || 'application/octet-stream', size: f.size, isInline: false });
      d.edited = true;
    }
    save();
    return clone(d);
  },
  async removeAttachment(draftId, attachmentId) {
    const d = getDraftState(draftId);
    d.attachments = d.attachments.filter((a) => a.id !== attachmentId);
    d.edited = true;
    save();
    return clone(d);
  },
  async discardDraft(draftId) {
    const d = state.drafts.find((x) => x.id === draftId);
    state.drafts = state.drafts.filter((x) => x.id !== draftId);
    changed(d ? [d.accountId] : []);
    emit(EVENTS.draftDocked, { draftId });
  },
  async sendDraft(draftId) {
    const d = getDraftState(draftId);
    if (d.to.length + d.cc.length + d.bcc.length === 0) throw new Error('Add at least one recipient.');
    const online = !hasWindow || navigator.onLine;
    if (!online) {
      d.status = 'queued';
      save();
      changed([d.accountId]);
      return clone(d);
    }
    d.status = 'sent';
    const sent = folderOf(d.accountId, 'sent');
    const me = myAddress(d.accountId);
    state.messages.push({
      id: `msg-${Math.random().toString(36).slice(2, 9)}`,
      accountId: d.accountId,
      folderId: sent?.id ?? '',
      conversationId: d.conversationId ?? `conv-${d.id}`,
      from: me,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      replyTo: [],
      subject: d.subject || '(no subject)',
      snippet: htmlToText(d.bodyHtml).slice(0, 140),
      receivedAt: now().toISOString(),
      isRead: true,
      isFlagged: false,
      hasAttachments: d.attachments.length > 0,
      isDraft: false,
      bodyHtml: d.bodyHtml,
      remoteImagesBlocked: false,
      attachments: d.attachments,
    });
    if (d.sourceMessageId) {
      const src = state.messages.find((m) => m.id === d.sourceMessageId);
      if (src) src.isRead = true;
    }
    const result = clone(d);
    state.drafts = state.drafts.filter((x) => x.id !== draftId);
    changed([d.accountId]);
    emit(EVENTS.draftDocked, { draftId });
    return result;
  },

  async search(query) {
    const messages = runSearch(query, state.messages);
    const who = query.from ?? query.to;
    const contact = who ? people().find((p) => p.email.toLowerCase() === who.toLowerCase()) : undefined;
    return { messages, total: messages.length, contact, fromServer: false } satisfies SearchResult;
  },
  async searchServer(query) {
    await sleep(500);
    const local = runSearch(query, state.messages);
    const remote = runSearch({ ...query, allFolders: true }, state.serverOnly).filter((r) => !local.some((l) => l.id === r.id));
    const messages = [...local, ...remote];
    const who = query.from ?? query.to;
    const contact = who ? people().find((p) => p.email.toLowerCase() === who.toLowerCase()) : undefined;
    return { messages, total: messages.length, contact, fromServer: true };
  },
  async listPeople(query, limit) {
    const q = query.trim().toLowerCase();
    return people()
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
      .slice(0, limit);
  },
  async getPerson(email) {
    return people().find((p) => p.email.toLowerCase() === email.toLowerCase()) ?? null;
  },

  async listCalendars() {
    return clone(state.calendars);
  },
  async refreshWebCalendars() {
    /* The demo has no Outlook page to read. */
  },
  async fetchWebEventAttendees() {
    /* The demo has no Outlook page to read; demo events carry their attendees already. */
    return [];
  },
  async openWebEvent() {
    /* The demo has no Outlook page to navigate. */
  },
  async setCalendarVisible(calendarId, visible) {
    const c = state.calendars.find((x) => x.id === calendarId);
    if (c) c.visible = visible;
    save();
  },
  async listEvents(start, end) {
    return clone(visibleEvents().filter((e) => e.end > start && e.start < end).sort((a, b) => a.start.localeCompare(b.start)));
  },
  async searchEvents({ text, field = 'all', after, before, limit = 200 }) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length && !after && !before) return [];
    const people = (e: CalendarEvent) => [e.organizer.name, e.organizer.email, ...e.attendees.flatMap((a) => [a.address.name, a.address.email])];
    const hay = (e: CalendarEvent) =>
      (field === 'title' ? [e.subject] : field === 'people' ? people(e) : [e.subject, e.location, ...people(e), htmlToText(e.bodyHtml)]).join(' ').toLowerCase();
    const afterMs = after ? new Date(after).getTime() : -Infinity;
    const beforeMs = before ? new Date(before).getTime() : Infinity;
    return clone(
      visibleEvents()
        .filter((e) => words.every((w) => hay(e).includes(w)))
        .filter((e) => new Date(e.end).getTime() > afterMs && new Date(e.start).getTime() < beforeMs)
        .sort((a, b) => b.start.localeCompare(a.start))
        .slice(0, limit),
    );
  },
  async agenda(days) {
    const ref = now();
    const today = startOfDay(ref);
    const out: AgendaDay[] = [];
    const events = visibleEvents();
    for (let i = 0; i < days; i++) {
      const day = addDays(today, i);
      const next = addDays(day, 1);
      const dayEvents = events
        .filter((e) => new Date(e.start) < next && new Date(e.end) > day)
        .filter((e) => (i === 0 ? new Date(e.end) > ref : true))
        .sort((a, b) => a.start.localeCompare(b.start));
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayName(day.getDay());
      out.push({ label, date: day.toISOString(), events: clone(dayEvents) });
    }
    return out;
  },
  async createEvent(input) {
    if (account(input.accountId).kind !== 'graph') throw new Error('Web accounts manage their calendar in Outlook on the web');
    if (state.calendars.find((c) => c.id === input.calendarId)?.readOnly) throw new Error('You can’t add events to that calendar');
    const e = eventFromInput(input);
    state.events.push(e);
    save();
    emit(EVENTS.mailChanged, { accountIds: [e.accountId] });
    return clone(e);
  },
  async updateEvent(eventId, input) {
    editableEvent(eventId);
    const idx = state.events.findIndex((e) => e.id === eventId);
    state.events[idx] = eventFromInput(input, state.events[idx]);
    save();
    emit(EVENTS.mailChanged, { accountIds: [input.accountId] });
    return clone(state.events[idx]);
  },
  async respondEvent(eventId, response) {
    const e = editableEvent(eventId);
    e.myResponse = response;
    const me = myAddress(e.accountId);
    const att = e.attendees.find((a) => a.address.email === me.email);
    if (att) att.response = response;
    save();
    return clone(e);
  },
  async deleteEvent(eventId) {
    editableEvent(eventId);
    state.events = state.events.filter((e) => e.id !== eventId);
    save();
  },

  async listSignatures(accountId) {
    return clone(state.signatures.filter((s) => !accountId || s.accountId === accountId));
  },
  async saveSignature(signature) {
    const sig = clone(signature);
    if (!sig.id) sig.id = `sig-${Math.random().toString(36).slice(2, 9)}`;
    const others = state.signatures.filter((s) => s.accountId === sig.accountId && s.id !== sig.id);
    if (sig.defaultNew) others.forEach((s) => (s.defaultNew = false));
    if (sig.defaultReply) others.forEach((s) => (s.defaultReply = false));
    const idx = state.signatures.findIndex((s) => s.id === sig.id);
    if (idx >= 0) state.signatures[idx] = sig;
    else state.signatures.push(sig);
    save();
    return clone(sig);
  },
  async deleteSignature(signatureId) {
    state.signatures = state.signatures.filter((s) => s.id !== signatureId);
    save();
  },

  async getSettings() {
    return clone(state.settings);
  },
  async updateSettings(patch) {
    Object.assign(state.settings, patch);
    save();
    return clone(state.settings);
  },
  async syncNow(accountId) {
    const targets = state.accounts.filter((a) => a.kind === 'graph' && (!accountId || a.id === accountId));
    targets.forEach((a) => (a.syncState = 'syncing'));
    emit(EVENTS.accountsChanged, clone(state.accounts));
    emit(EVENTS.syncStatus, await demoApi.syncStatus());
    await sleep(700);
    targets.forEach((a) => {
      a.syncState = 'idle';
      a.lastSyncedAt = now().toISOString();
    });
    save();
    emit(EVENTS.accountsChanged, clone(state.accounts));
    emit(EVENTS.syncStatus, await demoApi.syncStatus());
  },
  async syncStatus(): Promise<SyncStatus> {
    const online = !hasWindow || navigator.onLine;
    const syncing = state.accounts.some((a) => a.syncState === 'syncing');
    const held = state.drafts.filter((d) => d.status === 'unknown' || d.status === 'queued').length;
    const label = !online ? 'Offline · changes will sync' : syncing ? 'Syncing…' : 'Sample data · nothing syncs';
    const times = state.accounts.filter((a) => a.kind === 'graph' && a.lastSyncedAt).map((a) => a.lastSyncedAt!);
    const lastSyncedAt = times.length ? times.reduce((m, t) => (t < m ? t : m)) : undefined;
    return { online, syncing, label, lastSyncedAt, outboxHeld: held, demo: true };
  },
  async diskEncryption() {
    if (hasWindow && new URLSearchParams(window.location.search).get('disk') === 'off') return 'off';
    return 'on';
  },
  async popOut(kind, id) {
    if (kind === 'draft') {
      const d = getDraftState(id);
      d.poppedOut = true;
      save();
      emit(EVENTS.draftChanged, { draftId: id });
      if (hasWindow) window.open(`${location.pathname}${location.search}#/compose/${id}`, `draft-${id}`, 'width=960,height=720');
    } else if (hasWindow) {
      window.open(`${location.pathname}${location.search}#/message/${id}`, `message-${id}`, 'width=960,height=760');
    }
  },
  async dockBack(draftId) {
    const d = state.drafts.find((x) => x.id === draftId);
    if (d) d.poppedOut = false;
    save();
    emit(EVENTS.draftDocked, { draftId });
    if (hasWindow && location.hash.startsWith('#/compose/')) window.close();
  },

  async showWebAccount() {
    /* The desktop app places a native web view here. */
  },
  async hideWebAccounts() {},
  async reloadWebAccount() {},
  async openExternal(url) {
    if (hasWindow) window.open(url, '_blank', 'noopener');
  },

  // The preview can't update itself. `?update=ready` shows the update banner and settings as
  // they look once a new version has downloaded.
  async updateStatus() {
    return demoUpdate();
  },
  async checkForUpdate() {
    return demoUpdate();
  },
  async installUpdate() {},
};

function demoUpdate(): UpdateStatus {
  const ready = hasWindow && new URLSearchParams(window.location.search).get('update') === 'ready';
  return ready ? { state: 'ready', currentVersion: '0.1.0', version: '0.2.0', checkedAt: now().toISOString() } : { state: 'unavailable', currentVersion: '0.1.0' };
}
