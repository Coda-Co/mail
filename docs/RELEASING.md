# Building, signing and releasing

The app is internal only (spec §6). Releases are signed, notarised on macOS, and served to the updater from a private channel.

## Local builds

```bash
pnpm install --frozen-lockfile
pnpm tauri build
```

Installers are written to `target/release/bundle/` (`.app` and `.dmg` on macOS, NSIS `.exe` on Windows).

The minimum macOS version is 14 (`bundle.macOS.minimumSystemVersion`). That is what per-account WKWebView storage for web accounts needs; confirm it in the milestone-1 spike.

## Code signing

| Platform | What's needed | Where it goes |
|---|---|---|
| macOS | Apple Developer ID Application certificate, plus an app-specific password or API key for notarisation | CI secrets `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | A code-signing certificate (an OV/EV certificate, or Azure Trusted Signing) | `bundle.windows.certificateThumbprint`, or `bundle.windows.signCommand` for Trusted Signing |

`.github/workflows/release.yml` uses these when the secrets are present.

## Auto-update

The updater is behind the `updater` cargo feature so that development builds don't need keys.

Generate the updater key pair once:

```bash
pnpm tauri signer generate -w ~/.tauri/mail-updater.key
```

Then:

1. Put the public key in `src-tauri/tauri.updater.conf.json` (`plugins.updater.pubkey`). The endpoint is this public repository's latest release (`https://github.com/Coda-Co/mail/releases/latest/download/latest.json`), which `tauri-action` uploads. Releases are created as drafts; clients only see an update once the draft is published. The private key lives at `~/.tauri/mail-updater.key` on the release machine.
2. Store the private key and its password in CI as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Release builds use:

   ```bash
   pnpm tauri build --features updater -c src-tauri/tauri.updater.conf.json
   ```

### What users see

Code: `src-tauri/src/updater.rs`.

- The app checks the release channel 15 seconds after launch, then whenever the last check is over 4 hours old (it looks every 10 minutes, so a laptop that slept checks soon after waking).
- A new version downloads in the background and is verified against the public key. Then:
  - a banner above the mail view says "Mail x.y.z is ready" with **Restart now** and **Later** (Later hides it until the next version);
  - the settings button gets a dot;
  - a desktop notification goes out once per version (if notifications are on);
  - the tray / menu-bar item changes to **Restart to update to x.y.z**.
- **Restart now** saves web-account sign-ins as quitting does, installs and relaunches. On macOS a downloaded update also installs when the user quits; on Windows the installer runs only on restart, because it shows a window and relaunches the app.
- To check by hand: **Settings → General → Updates → Check for updates** (it also shows the current version and when the app last checked), or **Check for updates…** in the tray / menu-bar menu.

Builds without the `updater` feature, and `pnpm tauri dev`, show the version and say the build doesn't update itself. In the browser preview, `?update=ready` shows the banner and settings as they look with an update ready.

## Before retiring Outlook

Spec milestone 7: live in the app for two weeks.
