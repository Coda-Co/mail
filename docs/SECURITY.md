# Mail app: security note for Microsoft 365 admins

This page is for the admin of a Microsoft 365 tenant who has been asked to approve the Coda & Co mail app. It covers what the app requests, where data lives and how to revoke access.

## What it is

A desktop mail and calendar app for Windows and macOS, used internally at Coda & Co. It signs in to Microsoft 365 as the user, through Microsoft's own sign-in page, to read and send that user's own mail and manage that user's own calendar.

## What it requests

The app is a multi-tenant **public client** (no client secret). Publisher verification is via Microsoft Partner Center. It uses **delegated permissions only**: it can only do what the signed-in user can do, and only for their own mailbox.

| Permission | Why |
|---|---|
| `offline_access` | Stay signed in between launches (refresh token) |
| `User.Read` | Read the user's name and email, and the organisation name to label the account |
| `Mail.ReadWrite` | Read mail, mark read/flagged, move, archive, delete, and save drafts |
| `Mail.Send` | Send mail the user writes |
| `Calendars.ReadWrite` | Show the user's calendar, respond to invitations, and create or edit their events |

It does **not** request:

- application permissions;
- access to other users' mailboxes, shared mailboxes or public folders;
- directory read, Teams, Files or SharePoint access.

## Where data lives

- **On the user's device only.** Mail and calendar are stored in a local SQLite database per account under the user's app data folder. By default this holds 6 months of full messages and a rolling calendar window of 3 months back and 12 months forward.
- **Disk encryption.** The app relies on full-disk encryption (BitLocker or FileVault) and warns at start-up if it is off.
- **Tokens.** Sign-in tokens are kept in the operating system's credential store (Windows Credential Manager or macOS Keychain), never in files.
- **No Coda & Co servers in the path.** The app talks directly to `login.microsoftonline.com` and `graph.microsoft.com`; no mail, calendar data or tokens are sent to Coda & Co or anyone else.
- **AI agents.** An optional local agent bridge (MCP) is off by default. When the user turns it on, it is enabled per account and runs only on the device. Agents can read mail and create drafts, but cannot send.
- **Removing the account** in the app deletes its local database, cached attachments and tokens.

## How to approve

Open the admin consent link the user sent you, or go to:

```
https://login.microsoftonline.com/<your-tenant>/v2.0/adminconsent?client_id=<client-id>&redirect_uri=http://localhost&scope=https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite
```

You can also approve it for specific users only, through user assignment on the enterprise application.

## How to revoke

- **For everyone:** Entra admin centre → Enterprise applications → the mail app → Properties → Delete. Or Permissions → Revoke.
- **For one user:** Entra admin centre → Users → the user → Revoke sessions. Or remove their assignment to the app.
- **The user themselves:** remove the account in the app, or go to [myapps.microsoft.com](https://myapps.microsoft.com) and revoke the app.

## Contact

Coda & Co. Ask the person who sent you this page.
