# Mail app: product and technical spec

Working name: **mail-app** (final name TBD, see "Open decisions").
Status: draft v0.1, 23 November 2026.
Mockups: https://claude.ai/artifact/7PrypALbsct2WJC8gH5B72 (copies and design tokens in `design/`)

## 1. Purpose

A lightweight, fast replacement for Outlook on Windows and macOS, covering only what I use: mail, calendar and finding people. It brings my Coda & Co mailbox and my client mailboxes into one window, works offline for every account that allows it, and behaves identically on both platforms.

### Goals

- One window for all my Microsoft 365 accounts, across tenants.
- Full offline mail and calendar for accounts using our own app registration.
- A fallback for client tenants that block third-party apps: Outlook on the web inside the app.
- Clean, quiet interface in the style of Outline. Keyboard first.
- Identical behaviour and shortcuts on Windows and macOS.

### Non-goals (v1)

- Anything beyond mail, calendar and people: no tasks, notes, RSS, ribbon or add-ins.
- Non-Microsoft providers (Gmail, IMAP). The design should not rule them out.
- Mobile apps. I use Outlook mobile on my phone.
- Agent access over a local MCP server.
- Shared mailboxes, delegation, public folders, rules editing.
- Rich compose features beyond signatures (templates, scheduled send). Revisit after v1.

## 2. Accounts

Each account has one of two backends. The interface treats them the same where it can.

| | Graph account | Web account |
|---|---|---|
| When | Tenant allows our app (Coda & Co, consenting clients) | Tenant blocks third-party apps |
| How | Microsoft Graph via our own multi-tenant app registration | Outlook on the web in an embedded web view |
| Offline | Full (configurable window) | None |
| Mail list, search, agenda, people | Yes | No: own pane only |
| Unread count | From sync | Read from the page (best effort) |
| Notifications | From sync | Captured from the page's web notifications |

### Adding an account

1. User enters an email address.
2. App tries Graph sign-in (OAuth 2.0 authorisation code with PKCE, system browser, loopback redirect).
3. If Microsoft returns "Need admin approval" (AADSTS90093, 90094, 90095, 900941), offer:
   - **I'm an admin**: open the admin consent URL for that tenant.
   - **Ask my admin**: copy a short request message with the consent link and a link to our security note.
   - **Use web mode for now**: add the account as a Web account.
4. A Web account can be upgraded to Graph later ("Request approval" in the account's right-click menu).

### App registration

- One multi-tenant public client registration owned by Coda & Co, with publisher verification via Partner Center.
- Delegated permissions only, kept to the minimum:
  - `offline_access`, `User.Read`
  - `Mail.ReadWrite`, `Mail.Send`
  - `Calendars.ReadWrite`
  - `People.Read` (optional, for suggestions)
- No application permissions. No shared mailbox permissions in v1.
- A one-page security note for client admins: what is requested, where data lives, how to revoke.

## 3. Features

### 3.1 Mail

- **One mailbox at a time.** Each mailbox is its own space, like a separate app; there is no combined inbox. Mail opens the mailbox used last.
- **Rail** down the left: Mail (total unread), Calendar and People; Settings and your avatar at the bottom. Mail returns to the mailbox last open.
- **Mailbox tabs** in the top bar while Mail is open: one per mailbox (Graph and Web), then + to add an account. A tab shows the account colour, its name (plus the mailbox when two share a name), the unread count, a globe for Web accounts, and an orange ! for sign-in needed or a red ! for a sync error. The open mailbox is bold and underlined in its colour. Right-click a tab for Sign in again, Sync now, Account settings, Remove. Search sits on the right of the bar.
- **Folder icons** above the message list: Inbox, Unread (the inbox's unread mail), Drafts, Sent, Archive, Deleted, Junk, then a folder menu with the user's own folders.
- **Calendar** has its own sidebar listing each account's calendars to show or hide.
- **Reading pane** with actions: Reply, Reply all, Forward, Archive, Delete, Open in new window.
- **Replies draft at the top of the conversation**, above the message being answered, with From, To, Cc, Bcc, Send, Attach, Discard and Pop out. Drafts save to the server's Drafts folder automatically.
- **Pop out**: any message, reply or new message can open in its own window, and dock back.
- **Send** goes through an outbox queue: works offline, sends on reconnect. A send whose result is unknown is held and flagged, never sent twice.
- **From** defaults to the account the message came in on.
- **Signatures** (v1): rich formatting (bold, italic, links, colour, line breaks, an inline logo image). One or more per account, with a default for new messages and a default for replies and forwards. Inserted when a draft opens and swapped when From changes; the signature menu in compose adds, swaps or removes one on any draft. Edited in Settings with a small rich-text editor. Stored locally on each device; syncing signatures between devices is out of scope for v1.
- HTML mail rendered in a sandboxed view. Remote images shown by default, except in Junk; a setting switches to "ask before showing", and senders can be always allowed.
- Attachments in the offline window are downloaded during sync and cached locally; older ones download on demand. Cached files are removed once their mail leaves the window or is deleted.
- **Meeting invitations** show a card above the body: date, time and location, Accept / Tentative / Decline (sends the response straight away; a chevron offers adding a note first or not sending one), and the hours around the meeting from every visible calendar (all accounts, web calendars included), with the invitation outlined. Cancellations and replies show the time with their status. Open in Calendar jumps to the event.

### 3.2 Search

- Search **filters the current view** (the mailbox's folder). It does not open a separate screen.
- Scope chip: "In: Inbox, Coda & Co", widenable to all folders.
- Facet chips: **From**, **To**, **Has attachment**, **Unread**, **Date**, **Account**.
- Choosing a person in From or To shows a contact card above the results (Email, Copy address, message count).
- Runs against the local index first, instantly. "Search the server" extends results beyond the offline window.
- Shortcut: Ctrl+E (Cmd+E on Mac).

### 3.3 People

- Built from the people in my mail headers across all Graph accounts, de-duplicated by address, ranked by how recently and often I correspond.
- Reached through the From and To facets and the People view. No separate address book to maintain.

### 3.4 Calendar

- Day, work week and month views. All Graph accounts' calendars overlaid, each in its account colour, each toggleable.
- Event panel: details, attendees, Accept / Tentative / Decline (sends straight away; the chevron offers edit first or don’t send).
- Create and edit events, with invitations sent through the server.
- **Agenda panel** on the right of the mail view: Today, Tomorrow, then by weekday; time, account colour bar, title, location. Click through to the calendar.
- Reminders as desktop notifications.

### 3.5 Web accounts

- Outlook on the web fills the whole main panel. No extra header.
- Each account in its own isolated web view with separate storage, so sign-ins never collide.
- Web views stay loaded in the background to keep counts and notifications live.
- Unread count read from the page's Inbox count; neutral dot when it can't be read.
- Optional, per account: the calendar is read from Outlook on the web for a window around today and shown read-only in Calendar (docs/WEB_CALENDAR.md).

### 3.6 Notifications

- Native desktop notifications for new mail and reminders, labelled with the account.
- Per-account on/off. Tray or menu-bar badge with total unread.

## 4. Design

- Style: Outline-like. Light grey rail, white content, one blue accent, generous spacing.
- Type: Geist everywhere, headings included. Bundle the font with the app; never load it from the web.
- Light mode first; dark mode before v1 ships.
- Keyboard shortcuts identical on both platforms (Ctrl on Windows, Cmd on Mac):
  - Ctrl+N new message, Ctrl+R reply, Ctrl+Shift+R reply all, Ctrl+F forward (to confirm: clashes with find)
  - E archive, Delete delete, Ctrl+Z undo (archive, delete, move), Ctrl+Enter send, Ctrl+E search, Esc close or clear (closes a draft: an unchanged reply or forward, or a new message with no content, is discarded; anything else is saved. Closes a pop-out window)
  - Ctrl+1 calendar, Ctrl+2 people, Ctrl+3 to Ctrl+9 the mailboxes in tab order
- Narrow windows: agenda panel folds away first, then the reading pane stacks.

## 5. Architecture

### Stack (decided)

- **Shell: Tauri v2.** Small install, native web views on each platform (WebView2 on Windows, WKWebView on macOS), Rust back end.
- **Built from scratch.** Not built on MailCraft; it may be read as a reference for Graph behaviour only.
- **Core: Rust.** Graph client, sync engine, SQLite store, search index, outbox.
- **Interface: TypeScript + React** in the main web view, talking to the core through Tauri commands and events.
- **Web accounts:** additional Tauri web views, one per account, each with its own data store.
- **Storage:** SQLite with FTS5 for search. One database per account.
- **Secrets:** refresh tokens in the OS credential store (Windows Credential Manager, macOS Keychain).

Main risk: multi-webview with isolated storage per account on both platforms in Tauri (WebView2 user data folders; WKWebView data store identifiers need macOS 14+). **Spike this first.** If isolation in one window proves unreliable on a platform, fall back to one hidden window per web account on that platform, which gives each its own data store.

### Sync (Graph accounts)

- Folder list, then message delta queries per folder (`/messages/delta`), storing delta tokens.
- Poll the inbox delta every 10 seconds and run the full sync every 2 minutes while online; immediate sync on focus and after any action. Change notifications are out of scope for v1 (they need a public endpoint).
- Offline window per account (default 6 months of full messages; older mail as headers on demand).
- Calendar via `calendarView/delta` for a rolling window (for example 3 months back, 12 months forward).
- Local changes (read, flag, move, delete, drafts) queue and replay with retries. Respect `Retry-After` on 429 responses.
- Use immutable IDs (`Prefer: IdType="ImmutableId"`).

### Data on disk

- Client mail stored locally is sensitive. v1 relies on full-disk encryption (BitLocker, FileVault) and shows whether it is on in Settings (no warning).
- Option to encrypt the database (SQLCipher): decide before v1.
- "Remove account" deletes that account's database, cache and tokens.

## 6. Distribution

- Code signing: Apple Developer ID with notarisation; a Windows code-signing certificate.
- Auto-update via Tauri's updater, from a private release channel.
- Internal only (me, then the Coda team). Not published.

## 7. Milestones

1. **Spikes (1 to 2 weeks):** Tauri multi-webview isolation on both platforms (macOS minimum version follows from this); Graph sign-in and delta sync against my Coda mailbox; admin consent flow against a test tenant.
2. **Read-only mail:** accounts, unified inbox, reading pane, folders, offline store.
3. **Write mail:** reply at top, compose, pop-out windows, outbox, drafts, archive, delete, flag, signatures.
4. **Search and people:** local index, facets, contact cards.
5. **Calendar:** week view, agenda panel, responding, create and edit.
6. **Web accounts:** isolated web views, unread count, notifications.
7. **Polish:** dark mode, notifications, shortcuts, signing, updates. Then live in it for two weeks before retiring Outlook.

## 8. Decisions made

- Shell: Tauri v2.
- Built from scratch, not on MailCraft.
- Signatures with rich formatting are in v1.
- Font: Geist everywhere.

## 9. Open decisions

1. **Name.** Shortlist: Tern, Pigeonhole, Wren, Satchel. Check trademarks and domains before committing.
2. **Database encryption:** full-disk only, or SQLCipher too.
3. **Client permission to store mail locally:** check each client's terms before adding them as a Graph account.
4. **Ctrl+F:** forward (Outlook) or find in message.
5. **Who else uses it:** me only, or the Coda team (affects onboarding, updates and support).
6. **Minimum macOS version:** likely 14 (Sonoma), confirmed by the web view spike.
