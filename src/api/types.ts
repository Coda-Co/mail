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
  /** Months of full messages kept offline (Graph accounts). */
  offlineMonths: number;
  syncState: SyncState;
  syncError?: string;
  lastSyncedAt?: string;
  tenantId?: string;
  /** Outlook on the web URL for web accounts. */
  webUrl?: string;
  /** Web accounts: the calendar is read from Outlook on the web (off by default). */
  webCalendar: boolean;
  /** Last successful read of the web calendar. */
  webCalendarSyncedAt?: string;
  /** Short code for the last failed read (`signed_out`, `timeout`, `http_500`, ...). */
  webCalendarError?: string;
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
  /** Drafts folder only: messages waiting to send, held ones included. */
  outbox?: number;
}

export interface Address {
  name: string;
  email: string;
}

/** 'outbox' applies to the Drafts folder: messages sent but not yet gone. */
export type ListTab = 'all' | 'unread' | 'flagged' | 'outbox';

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
  /** The conversation has a reply or forward the user started and hasn't sent. */
  hasDraft?: boolean;
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
  /** Meeting requests, cancellations and responses, once the event has been read. */
  meeting?: MeetingInfo;
}

export type MeetingKind = 'request' | 'cancelled' | 'accepted' | 'tentative' | 'declined' | 'other';

/** When and where a meeting message's event is, as the message said. */
export interface MeetingInfo {
  kind: MeetingKind;
  start: string;
  end: string;
  isAllDay: boolean;
  location: string;
  eventId?: string;
  /** The event in the local calendar, when it is there: its time wins and it carries my response. */
  event?: CalendarEvent;
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
  /** No new events, edits or responses here (web calendars, shared read-only calendars). */
  readOnly: boolean;
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
  /** From a read-only calendar: no responses, edits or deletes here. */
  readOnly: boolean;
}

/** What event search text is matched against. "people" is organizer and attendees. */
export type EventField = 'title' | 'people' | 'all';

export interface EventQuery {
  text: string;
  /** Defaults to "all". */
  field?: EventField;
  /** Only events ending after this time. */
  after?: string;
  /** Only events starting before this time. */
  before?: string;
  limit?: number;
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
  remoteImageSenders: string[];
  /** 'show': load remote images except in Junk; 'ask': block until shown or the sender is allowed. */
  remoteImages: 'show' | 'ask';
  /** Working hours, in minutes after midnight (quarter hours). The calendar shades the rest. */
  workStart: number;
  workEnd: number;
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
  updateAccount(accountId: string, patch: Partial<Pick<Account, 'displayName' | 'color' | 'notifications' | 'offlineMonths' | 'webCalendar'>>): Promise<Account>;
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
  /** Puts the files on the system clipboard, downloading any not cached yet. */
  copyAttachments(messageId: string, attachmentIds: string[]): Promise<void>;

  createDraft(req: { mode: DraftMode; sourceMessageId?: string; accountId?: string }): Promise<Draft>;
  getDraft(draftId: string): Promise<Draft>;
  updateDraft(draft: Draft): Promise<Draft>;
  /** Swap From: re-inserts that account's signature. */
  changeDraftAccount(draftId: string, accountId: string): Promise<Draft>;
  /** Add, swap or remove (null) the draft's signature without changing From. */
  setDraftSignature(draftId: string, signatureId: string | null): Promise<Draft>;
  addAttachment(draftId: string): Promise<Draft>;
  /** Attach a file dropped onto the draft (from Explorer, Finder or the desktop). */
  addAttachmentFile(draftId: string, file: File): Promise<Draft>;
  removeAttachment(draftId: string, attachmentId: string): Promise<Draft>;
  discardDraft(draftId: string): Promise<void>;
  sendDraft(draftId: string): Promise<Draft>;
  /** Take a message in the Outbox back to Drafts; it won't be sent. Fails once it's going out. */
  cancelSend(draftId: string): Promise<Draft>;

  search(query: SearchQuery): Promise<SearchResult>;
  searchServer(query: SearchQuery): Promise<SearchResult>;
  listPeople(query: string, limit: number): Promise<Person[]>;
  getPerson(email: string): Promise<Person | null>;
  /** Recent mail from or to someone, across folders (in one account, or all), newest first. */
  personMail(email: string, accountId: string | undefined, limit: number): Promise<MessageSummary[]>;

  listCalendars(): Promise<CalendarInfo[]>;
  setCalendarVisible(calendarId: string, visible: boolean): Promise<void>;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;
  /** Events matching every word in the query's field, within its dates, latest first. */
  searchEvents(query: EventQuery): Promise<CalendarEvent[]>;
  agenda(days: number): Promise<AgendaDay[]>;
  createEvent(input: EventInput): Promise<CalendarEvent>;
  updateEvent(eventId: string, input: EventInput): Promise<CalendarEvent>;
  /** sendResponse defaults to true; comment is a note to the organiser, ignored when nothing is sent. */
  respondEvent(eventId: string, response: 'accepted' | 'tentative' | 'declined', options?: { sendResponse?: boolean; comment?: string }): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;

  listSignatures(accountId?: string): Promise<Signature[]>;
  saveSignature(signature: Signature): Promise<Signature>;
  deleteSignature(signatureId: string): Promise<void>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  syncNow(accountId?: string): Promise<void>;
  syncStatus(): Promise<SyncStatus>;
  diskEncryption(): Promise<DiskEncryption>;

  /** Open a message or draft in its own window. */
  popOut(kind: 'message' | 'draft', id: string): Promise<void>;
  /** Close the pop-out window and show the draft inline again. */
  dockBack(draftId: string): Promise<void>;

  /** Web accounts: show the account's web view over the main panel at these bounds (CSS px). */
  showWebAccount(accountId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  hideWebAccounts(): Promise<void>;
  reloadWebAccount(accountId: string): Promise<void>;
  /** Calendar opened: ask web accounts with the calendar on to refresh (at most once a minute). */
  refreshWebCalendars(): Promise<void>;
  /**
   * Fetch a web-calendar event's attendees on demand (the calendar view doesn't carry them).
   * Returns an empty list if the page can't answer (signed out, timed out); never throws.
   */
  fetchWebEventAttendees(accountId: string, eventId: string): Promise<Attendee[]>;
  /** Point the account's Outlook on the web view at one event's own page (the caller shows the view). */
  openWebEvent(accountId: string, eventId: string): Promise<void>;

  /** Open a link in the system browser (message links, admin consent URL). */
  openExternal(url: string): Promise<void>;

  updateStatus(): Promise<UpdateStatus>;
  /** Check the release channel now and download a new version if there is one. Resolves with the outcome. */
  checkForUpdate(): Promise<UpdateStatus>;
  /** Install the downloaded update and relaunch the app. */
  installUpdate(): Promise<void>;
}

export type UpdateState = 'unavailable' | 'idle' | 'checking' | 'downloading' | 'ready' | 'upToDate' | 'error' | 'installing';

export interface UpdateStatus {
  /** `unavailable`: this build can't update itself (development builds and the browser preview). */
  state: UpdateState;
  currentVersion: string;
  /** The new version, while downloading, ready or installing. */
  version?: string;
  /** Release notes for the new version. */
  notes?: string;
  /** Download progress, 0 to 1. */
  progress?: number;
  error?: string;
  /** When the release channel last answered (ISO). */
  checkedAt?: string;
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
  /** payload: UpdateStatus */
  updateStatus: 'update://status',
} as const;
