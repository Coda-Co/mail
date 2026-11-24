// Shared contract between the React interface and the Rust core.
// Rust mirrors these in crates/mail-core/src/model.rs (serde, camelCase).
// Dates are ISO 8601 strings in UTC.

export type AccountKind = 'graph' | 'web';
export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'needsAuth';

export interface Account {
  id: string;
  email: string;
  displayName: string;
  kind: AccountKind;
  /** Account colour from the palette; web accounts use the neutral grey. */
  color: string;
  /** Inbox unread count. null when it cannot be read (web accounts, best effort). */
  unread: number | null;
  notifications: boolean;
  agentsEnabled: boolean;
  /** Months of full messages kept offline (Graph accounts). */
  offlineMonths: number;
  syncState: SyncState;
  syncError?: string;
  lastSyncedAt?: string;
  tenantId?: string;
  /** Outlook on the web URL for web accounts. */
  webUrl?: string;
}

export type FolderRole = 'inbox' | 'drafts' | 'sent' | 'archive' | 'deleted' | 'junk';

export interface Folder {
  id: string;
  accountId: string;
  name: string;
  role: FolderRole | null;
  parentId?: string;
  unread: number;
  total: number;
}

export interface Address {
  name: string;
  email: string;
}

export type ListTab = 'all' | 'unread' | 'flagged';

/**
 * What the message list shows. No accountId = all Graph accounts (unified).
 * folder by role works across accounts; folder by id is one account's folder.
 */
export interface ViewScope {
  accountId?: string;
  folder: { role: FolderRole } | { id: string };
  tab: ListTab;
}

export interface MessageSummary {
  id: string;
  accountId: string;
  folderId: string;
  conversationId: string;
  from: Address;
  to: Address[];
  subject: string;
  snippet: string;
  receivedAt: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  isDraft: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentId?: string;
  /** Set once downloaded and cached locally. */
  localPath?: string;
}

export interface Message extends MessageSummary {
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  /** Sanitised HTML. Remote images are already stripped when blocked. */
  bodyHtml: string;
  remoteImagesBlocked: boolean;
  attachments: Attachment[];
}

export type DraftMode = 'new' | 'reply' | 'replyAll' | 'forward';
export type DraftStatus = 'editing' | 'queued' | 'sending' | 'sent' | 'unknown' | 'failed';

export interface Draft {
  id: string;
  accountId: string;
  mode: DraftMode;
  /** Message being replied to or forwarded. */
  sourceMessageId?: string;
  conversationId?: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** Body including the signature block. */
  bodyHtml: string;
  signatureId?: string;
  attachments: Attachment[];
  updatedAt: string;
  savedToServer: boolean;
  status: DraftStatus;
  error?: string;
  /** True while the draft is open in its own window. */
  poppedOut: boolean;
  /** False for a new draft nobody has changed yet; missing counts as edited. */
  edited?: boolean;
}

export interface Thread {
  conversationId: string;
  subject: string;
  /** Newest first. */
  messages: Message[];
  /** Local drafts in this conversation, shown above the messages. */
  drafts: Draft[];
}

export type DateFilter = 'any' | 'week' | 'month' | 'year';

/** What the search text is matched against. "content" is subject and body. */
export type SearchField = 'from' | 'to' | 'subject' | 'content' | 'all';

export interface SearchQuery {
  text: string;
  /** Defaults to "all". */
  field?: SearchField;
  scope: ViewScope;
  /** Widen "In: Inbox" to all folders. */
  allFolders: boolean;
  from?: string;
  to?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  date?: DateFilter;
  accountId?: string;
}

export interface Person {
  email: string;
  name: string;
  accountIds: string[];
  messageCount: number;
  lastContactAt: string;
  score: number;
}

export interface SearchResult {
  messages: MessageSummary[];
  total: number;
  /** Shown above results when From or To is a person. */
  contact?: Person;
  /** True when results include messages fetched from the server. */
  fromServer: boolean;
}

export interface CalendarInfo {
  id: string;
  accountId: string;
  name: string;
  color: string;
  visible: boolean;
  isDefault: boolean;
}

export type ResponseStatus = 'none' | 'organizer' | 'accepted' | 'tentative' | 'declined';

export interface Attendee {
  address: Address;
  type: 'required' | 'optional' | 'resource';
  response: ResponseStatus;
}

export interface CalendarEvent {
  id: string;
  accountId: string;
  calendarId: string;
  subject: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location: string;
  bodyHtml: string;
  organizer: Address;
  attendees: Attendee[];
  myResponse: ResponseStatus;
  isOnlineMeeting: boolean;
  onlineMeetingUrl?: string;
  reminderMinutes?: number;
  isCancelled: boolean;
  color: string;
}

export interface EventInput {
  accountId: string;
  calendarId?: string;
  subject: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location: string;
  bodyHtml: string;
  attendees: Address[];
  isOnlineMeeting: boolean;
  reminderMinutes?: number;
}

export interface AgendaDay {
  /** "Today", "Tomorrow", then weekday name. */
  label: string;
  date: string;
  events: CalendarEvent[];
}

export interface Signature {
  id: string;
  accountId: string;
  name: string;
  html: string;
  defaultNew: boolean;
  defaultReply: boolean;
}

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  notifications: boolean;
  /** What Ctrl+F does in the mail view (open decision 4). */
  ctrlF: 'forward' | 'find';
  mcpEnabled: boolean;
  /** Always false in v1: agents create drafts, the user sends. */
  mcpAllowSend: boolean;
  remoteImageSenders: string[];
  /** 'show': load remote images except in Junk; 'ask': block until shown or the sender is allowed. */
  remoteImages: 'show' | 'ask';
}

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  /** e.g. "Synced · offline ready" */
  label: string;
  lastSyncedAt?: string;
  outboxHeld: number;
  /** Showing built-in sample data, not real accounts (browser preview or MAIL_APP_DEMO=1). */
  demo?: boolean;
}

export type DiskEncryption = 'on' | 'off' | 'unknown';

export type AddAccountResult =
  | { kind: 'added'; account: Account }
  | {
      kind: 'needsAdminApproval';
      email: string;
      tenantId?: string;
      errorCode: string;
      adminConsentUrl: string;
      /** Ready-to-copy message for the user's admin. */
      requestMessage: string;
    }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

export interface McpInfo {
  enabled: boolean;
  command: string;
  args: string[];
  /** JSON snippet for an MCP client config. */
  configSnippet: string;
}

export interface Me {
  name: string;
  email: string;
}

/**
 * Every call the interface makes. Implemented by tauriApi (invoke) and demoApi
 * (in-memory, for browser development and screenshots).
 * Tauri command name = method name in snake_case, args passed as one object.
 */
export interface MailApi {
  me(): Promise<Me>;
  listAccounts(): Promise<Account[]>;
  addAccount(email: string): Promise<AddAccountResult>;
  addWebAccount(email: string, displayName: string): Promise<Account>;
  upgradeWebAccount(accountId: string): Promise<AddAccountResult>;
  updateAccount(accountId: string, patch: Partial<Pick<Account, 'displayName' | 'color' | 'notifications' | 'agentsEnabled' | 'offlineMonths'>>): Promise<Account>;
  removeAccount(accountId: string): Promise<void>;

  listFolders(accountId?: string): Promise<Folder[]>;
  listMessages(scope: ViewScope, limit: number, offset: number): Promise<MessageSummary[]>;
  getThread(messageId: string): Promise<Thread>;
  getMessage(messageId: string): Promise<Message>;
  markRead(ids: string[], read: boolean): Promise<void>;
  setFlag(ids: string[], flagged: boolean): Promise<void>;
  archive(ids: string[]): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  moveMessages(ids: string[], folderId: string): Promise<void>;
  allowRemoteImages(senderEmail: string): Promise<void>;
  showRemoteImagesOnce(messageId: string): Promise<Message>;
  openAttachment(messageId: string, attachmentId: string): Promise<void>;

  createDraft(req: { mode: DraftMode; sourceMessageId?: string; accountId?: string }): Promise<Draft>;
  getDraft(draftId: string): Promise<Draft>;
  updateDraft(draft: Draft): Promise<Draft>;
  /** Swap From: re-inserts that account's signature. */
  changeDraftAccount(draftId: string, accountId: string): Promise<Draft>;
  addAttachment(draftId: string): Promise<Draft>;
  removeAttachment(draftId: string, attachmentId: string): Promise<Draft>;
  discardDraft(draftId: string): Promise<void>;
  sendDraft(draftId: string): Promise<Draft>;

  search(query: SearchQuery): Promise<SearchResult>;
  searchServer(query: SearchQuery): Promise<SearchResult>;
  listPeople(query: string, limit: number): Promise<Person[]>;
  getPerson(email: string): Promise<Person | null>;

  listCalendars(): Promise<CalendarInfo[]>;
  setCalendarVisible(calendarId: string, visible: boolean): Promise<void>;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;
  agenda(days: number): Promise<AgendaDay[]>;
  createEvent(input: EventInput): Promise<CalendarEvent>;
  updateEvent(eventId: string, input: EventInput): Promise<CalendarEvent>;
  respondEvent(eventId: string, response: 'accepted' | 'tentative' | 'declined'): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;

  listSignatures(accountId?: string): Promise<Signature[]>;
  saveSignature(signature: Signature): Promise<Signature>;
  deleteSignature(signatureId: string): Promise<void>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  syncNow(accountId?: string): Promise<void>;
  syncStatus(): Promise<SyncStatus>;
  diskEncryption(): Promise<DiskEncryption>;
  mcpInfo(): Promise<McpInfo>;

  /** Open a message or draft in its own window. */
  popOut(kind: 'message' | 'draft', id: string): Promise<void>;
  /** Close the pop-out window and show the draft inline again. */
  dockBack(draftId: string): Promise<void>;

  /** Web accounts: show the account's web view over the main panel at these bounds (CSS px). */
  showWebAccount(accountId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  hideWebAccounts(): Promise<void>;
  reloadWebAccount(accountId: string): Promise<void>;

  /** Open a link in the system browser (message links, admin consent URL). */
  openExternal(url: string): Promise<void>;
}

/** Events the core emits (Tauri event names). */
export const EVENTS = {
  /** payload: { accountIds: string[] } — refetch lists */
  mailChanged: 'mail://changed',
  /** payload: SyncStatus */
  syncStatus: 'sync://status',
  /** payload: { accountId, unread: number | null } */
  webUnread: 'web-account://unread',
  /** payload: { draftId } — a pop-out draft was docked back or closed */
  draftDocked: 'draft://docked',
  /** payload: { draftId } — draft changed in another window */
  draftChanged: 'draft://changed',
  /** payload: Account[] */
  accountsChanged: 'accounts://changed',
} as const;
