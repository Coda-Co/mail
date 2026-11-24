# Web account calendars: spec

Status: **proposed, not built.** Pick-up notes for whoever implements it.

## 1. Goal

Show a web account's calendar events in the main Calendar view, read-only, for a window around today. Web accounts are the fallback for client tenants that block third-party apps (SPEC §2, §3.5), so there is no Graph access for them. The events come from the account's Outlook on the web view, which is already loaded in the background with the user's own sign-in.

### Non-goals

- Creating, editing, deleting or responding to events for web accounts. Those happen in Outlook on the web.
- Reminders for web events (v1). Outlook on the web already notifies through the existing notification bridge.
- Calendars other than the user's default calendar (shared, group or other people's calendars).
- Event bodies (v1). Subject, time, location, organiser, attendees and the online meeting link are enough to plan a day.

## 2. Policy and consent

These tenants block third-party apps on purpose. Copying their calendar data into this app works around that, even though it is only the user's own calendar, read-only, on their own device. So:

- **Off by default, per account.** A toggle in the account's settings: **"Show this calendar in Calendar"**.
- Turning it on shows a confirmation that says, in plain words: this reads your calendar from Outlook on the web and stores the next few weeks on this device; this tenant blocks third-party apps, so check the client is fine with it.
- Turning it off deletes every stored web event and calendar row for that account straight away.
- Data never leaves the device. The page fetches from its own Outlook origin and hands the result to the core; nothing else.

## 3. Behaviour

| | |
|---|---|
| Window | 14 days back to 42 days forward from today (constants in one place). Events outside it are pruned on each refresh. |
| Refresh | When the toggle is turned on, when the web view finishes loading, every 10 minutes after that, and when the user opens the Calendar view (at most once a minute). |
| Read-only | No Going / Maybe / No, Edit or Delete in the event panel. Web calendars never appear in the new-event account or calendar picker. |
| Look | Events use the account's colour (web accounts are neutral grey) and a small "web" tag, like the sidebar. The event panel shows "From Outlook on the web · updated 4 min ago" and an **Open in Outlook on the web** button that switches to that account's web view. |
| Visibility | The web calendar appears in the calendar list with its toggle like any other calendar (`calendar_visibility`). |
| Staleness | If the last good refresh is older than 1 hour, the calendar list shows "Not updated since 10:42" next to it. If the page is signed out or the fetch fails, keep the last good data and show the error there. Never wipe data on a failed fetch. |
| Agenda | Web events show in the agenda panel the same way (it reads `list_events`). |
| Upgrade to Graph | `upgrade_web_account` deletes the web calendar rows so Graph sync takes over cleanly. The toggle is irrelevant once the account is Graph. |

## 4. Design

### 4.1 Who drives the refresh

The core owns the schedule and pushes a request into the page; the page answers with a report. The page gets **no new way to read anything from the app**: it can only push events for its own account, as it already does for the unread count.

1. Rust (`src-tauri/src/webaccounts.rs`) runs a small loop (like `events::reminder_loop`). For each web account with the toggle on and a loaded view, it calls
   `webview.eval("window.__mailCalendarFetch && window.__mailCalendarFetch(<start>, <end>, <requestId>)")`
   with RFC 3339 strings and a random request id kept in memory.
2. `src-tauri/src/web_account.js` defines `window.__mailCalendarFetch` (non-enumerable, top frame and Outlook hosts only, as the existing guards do). It fetches the events (§4.2), normalises them (§4.3) and calls
   `web_account_calendar_report { requestId, start, end, events, error }`.
3. The new command (next to `web_account_report`) works out the account from the web view label (`account_of`), checks the account is web, the toggle is on and `requestId` matches an outstanding request (drop anything unsolicited), validates, then stores.

### 4.2 Fetching from Outlook on the web

**The exact call has to be found against a real, signed-in Outlook on the web session; it can't be worked out from here.** Steps for the implementer:

1. Open a web account in a debug build, open the web view's DevTools (WebView2 / Safari Web Inspector), go to the Calendar in Outlook on the web and watch the Network tab while switching weeks.
2. Identify the request the page itself uses to load a date range of events. Expect a same-origin call on the Outlook host (for example an `/owa/service.svc?action=...` calendar view action, or a REST-style `.../calendarview?startDateTime=...&endDateTime=...` call), with whatever headers the page adds.
3. Copy that request's shape into `web_account.js`, in one function (`fetchCalendarRange(start, end)`). Write down what you found (endpoint, required headers, response fields used, date checked) in §8 of this file, since the next person will need it when Outlook changes.

Rules for the fetch:

- Same-origin requests to the current Outlook host only. No other hosts.
- Use what the page already uses (its cookies and whatever request headers it sets). If a bearer token is needed, read it the same way the page does, at the time of the call, and **never pass a token, cookie or header value to the app**. Only normalised event data crosses the bridge.
- Request only the fields in §4.3. Ask for no bodies.
- Page through results until the range is complete, capped at 2,000 events. Report `error: "too_many"` above that.
- 30-second timeout. On any failure, report `{ error: "<short code>", events: [] }` (`signed_out`, `http_<status>`, `parse`, `timeout`, `too_many`, `unsupported`).
- Keep it tolerant: Outlook's internals are not an API and will change. A failure must only mark the calendar stale, never break mail, the unread count or notifications.

### 4.3 Payload

`events` is a list of:

```ts
{
  id: string;            // Outlook's item id for the occurrence (recurring occurrences need distinct ids)
  subject: string;
  start: string;         // RFC 3339 with offset, or a date for all-day
  end: string;
  isAllDay: boolean;
  location: string;
  organizer: { name: string; email: string };
  attendees: { name: string; email: string; type: 'required' | 'optional' | 'resource'; response: ResponseStatus }[];
  myResponse: ResponseStatus;   // 'none' | 'organizer' | 'accepted' | 'tentative' | 'declined'
  showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere';
  isOnlineMeeting: boolean;
  onlineMeetingUrl?: string;
  isCancelled: boolean;
}
```

Expand recurring series into occurrences inside the window (ask the server for a calendar view, not the series masters).

Validation in Rust (reject the whole report on a structural problem, drop single bad events otherwise):

- At most 2,000 events. Strings trimmed and capped (id 512, subject 500, location 300, names 200, emails 320), at most 200 attendees per event.
- `start` and `end` parse; `end >= start`; the event overlaps the requested range.
- `onlineMeetingUrl` kept only if it is `https://`.
- `requestId` matches; `start`/`end` equal the requested range.
- Dedupe by id (last wins).

### 4.4 Storage

Web accounts don't have an account database yet, but `Service::account_db` creates one lazily, and its `calendars` and `events` tables (`crates/mail-core/src/db/account.rs`) already fit.

- One calendar row per web account: id `web-default`, name "Calendar", `is_default = 1`, `can_edit = 0`.
- Store a report in **one transaction**: delete events for `web-default` that overlap the requested range, insert the new ones (`upsert_event`, with `body_html = ''`, `reminder_minutes = NULL`, `local_only = 0`), and delete events that end before the window start.
- App database migration (append to `MIGRATIONS` in `crates/mail-core/src/db/app.rs`):
  ```sql
  ALTER TABLE accounts ADD COLUMN web_calendar INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accounts ADD COLUMN web_calendar_synced_at TEXT;
  ALTER TABLE accounts ADD COLUMN web_calendar_error TEXT;
  ```
  Successful report: set `web_calendar_synced_at`, clear the error. Failed report: set the error, keep data and time.
- Emit `accounts://changed` only when the error state changes, and `mail://changed`-style calendar refresh (whatever the Calendar view listens to today) only when stored events actually changed. Don't emit on every refresh: re-sent account lists are what caused the web view flicker fixed in `WebAccountView.tsx`.

### 4.5 Core changes (`crates/mail-core/src/service.rs`)

- `list_calendars`: include web accounts with `web_calendar = 1`, with a new `read_only: true` (Graph calendars: `!can_edit`).
- `list_events`: iterate Graph accounts **plus** web accounts with the toggle on (today it uses `graph_accounts()`). Set a new `read_only` field on each event from its calendar.
- `agenda_at`: follows from `list_events`; check it.
- `due_reminders`: skip web accounts.
- `update_event`, `respond_event`, `delete_event`: return `Error::Invalid("This event is read-only. Change it in Outlook on the web.")` for web accounts or `can_edit = 0` calendars.
- `update_account`: accept `webCalendar: boolean`. Turning it off deletes the `web-default` calendar and its events and clears the two status columns.
- `upgrade_web_account`: delete the web calendar rows and reset the three columns.
- Model: `Account` gains `web_calendar: bool`, `web_calendar_synced_at: Option<String>`, `web_calendar_error: Option<String>`; `CalendarEvent` and `CalendarInfo` gain `read_only: bool`.

### 4.6 Shell (`src-tauri`)

- `webaccounts.rs`: the refresh loop (§4.1), the in-memory outstanding-request map, the `web_account_calendar_report` command, and a trigger when the toggle turns on and on page load (an `on_page_load` handler on the web view builder, or the existing script calling `web_account_report` on load is enough as a "loaded" signal).
- `lib.rs`: register the command.
- `permissions/app.toml`: add `allow-web-account-calendar-report` to the `web-account-reporting` set only. Do **not** add it to `app-windows`.
- `capabilities/web-accounts.json`: update the description.
- Update the module doc comment at the top of `webaccounts.rs`, which says the page may call only two commands.

### 4.7 Interface (`src`)

- `api/types.ts`: the new fields (§4.5) and `updateAccount` patch key `webCalendar`.
- `views/SettingsModal.tsx`: the toggle for web accounts, the confirmation (§2), and the status line ("Updated 4 min ago" / the error).
- `views/CalendarView.tsx` `EventModal`: when `event.readOnly`, hide response buttons, Edit and Delete; show the source line and **Open in Outlook on the web**. Add the "web" tag on event blocks from web accounts.
- Calendar list: the stale/error note (§3).
- `views/EventForm.tsx`: make sure read-only calendars and web accounts never appear as targets.
- `api/demo.ts` / `api/demoData.ts`: give the demo web account a few read-only events so `pnpm dev` shows the feature, and keep `demo.test.ts` passing.

### 4.8 Docs

- SPEC §3.5: add a bullet: "Optional, per account: the calendar is read from Outlook on the web for a window around today and shown read-only in Calendar."
- README milestone 6 row: mention it, and that it needs checking on Windows and macOS.

## 5. Tests

Rust (`mail-core`, in-memory service):

- A report replaces events in its range, keeps events outside it, prunes events before the window.
- A failed report keeps data and sets the error; a later success clears it.
- Validation: oversize strings capped, bad times dropped, non-https meeting links dropped, more than 2,000 events rejected, mismatched range rejected.
- `list_events` and `list_calendars` include web events only while the toggle is on, and mark them read-only; hidden calendar visibility is respected.
- `respond_event`, `update_event`, `delete_event` refuse web events.
- `due_reminders` ignores web events.
- Toggle off and `upgrade_web_account` delete the rows.

Shell: an unsolicited report (unknown `requestId`) and a report from a non-web view are ignored.

Interface: `demo.test.ts` covers the read-only flag; the event modal hides the actions for read-only events.

## 6. Manual check (needs Windows and macOS, real tenant)

1. Add a web account, sign in, turn the toggle on, confirm. Events for this week and next appear within seconds.
2. Create, move and cancel a meeting in Outlook on the web; the change shows within 10 minutes (or on opening Calendar).
3. A recurring meeting shows each occurrence; all-day events land on the right day across time zones.
4. Sign out in the web view: data stays, the calendar list shows the error. Sign back in: it clears.
5. Toggle off: events disappear at once. Toggle on again: they come back.
6. No flicker in the web view during refreshes, and the unread count and notifications still work.

## 7. Open questions

- Window size: is 2 weeks back / 6 weeks forward right?
- Should `showAs` = free events be shown, faded or hidden?
- Is a body worth fetching later (meeting agenda, dial-in)? If so, it must go through the existing HTML sanitiser.

## 8. Findings from the real Outlook on the web session

_Fill in during implementation: endpoint, required headers, the response fields used, how paging works, and the date it was checked._
