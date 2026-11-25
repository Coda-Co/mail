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

## Before retiring Outlook

Spec milestone 7: live in the app for two weeks.
