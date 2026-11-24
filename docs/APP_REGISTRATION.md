# Setting up the Microsoft app registration

The app signs in through one multi-tenant public client registration owned by Coda & Co (spec §2). Until it exists, the app runs in demo mode or with web accounts only.

## 1. Register the app

In the Entra admin centre for the Coda & Co tenant, go to **App registrations → New registration** and set:

- **Name:** Mail, or the final product name.
- **Supported account types:** *Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant)*.
- **Redirect URI:** platform *Public client/native (mobile & desktop)*, value `http://localhost`. Entra accepts any port on `localhost` for public clients, and the app listens on a random loopback port.

Then:

- Under **Authentication**, set *Allow public client flows* to **No**. The app uses the authorisation code flow with PKCE, not device code or ROPC.
- Under **API permissions → Add → Microsoft Graph → Delegated**, add `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send` and `Calendars.ReadWrite`. `People.Read` is optional and unused in v1.
- Under **Branding & properties**, add the publisher domain and links. Then complete **publisher verification** through Partner Center: unverified multi-tenant apps get stricter consent prompts in client tenants.
- Under **Branding**, link to a public copy of [SECURITY.md](SECURITY.md).

## 2. Build with the client id

The client id is not a secret.

```bash
export MAIL_APP_CLIENT_ID=<application (client) id>
export MAIL_APP_SECURITY_NOTE_URL=<public URL of SECURITY.md>
pnpm tauri build
```

Both values are read at build time. `MAIL_APP_CLIENT_ID` can also be set when launching, which is useful during development.

## 3. Admin approval in client tenants

When a client tenant blocks user consent, sign-in fails with `AADSTS90093`, `90094`, `90095` or `900941`. The app then offers three options:

- **I'm an admin:** opens `https://login.microsoftonline.com/<domain>/v2.0/adminconsent?...` for that tenant.
- **Ask my admin:** copies a short message containing that link and the security note link.
- **Use web mode for now:** adds the account as a web account (Outlook on the web inside the app).

A web account can be upgraded later with **Request approval** in its right-click menu.

Test the whole flow against a test tenant with user consent turned off (spec milestone 1).
