# Building, signing and releasing

The app is internal only (spec §6). Releases are signed, notarised on macOS, and served to the updater from a private channel.

## Local builds

```bash
npm ci
cargo build --release -p mail-mcp
```

Copy the MCP sidecar where Tauri expects it, named with the target triple:

```bash
mkdir -p src-tauri/binaries
cp target/release/mail-mcp "src-tauri/binaries/mail-mcp-$(rustc -vV | sed -n 's/host: //p')"
```

```bash
MAIL_APP_CLIENT_ID=<client id> npx tauri build -c src-tauri/tauri.bundle.conf.json
```

On Windows the sidecar is `mail-mcp.exe` and the copy is named `mail-mcp-x86_64-pc-windows-msvc.exe`. Installers are written to `target/release/bundle/` (`.app` and `.dmg` on macOS, NSIS `.exe` on Windows).

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
npx tauri signer generate -w ~/.tauri/mail-updater.key
```

Then:

1. Put the public key in `src-tauri/tauri.updater.conf.json` (`plugins.updater.pubkey`), with the endpoint of the private release channel. The endpoint can be any HTTPS host that serves the `latest.json` Tauri produces, such as an S3 or R2 bucket behind access control. A private GitHub repository's releases won't work, because the updater can't authenticate.
2. Store the private key and its password in CI as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Release builds use:

   ```bash
   npx tauri build --features updater -c src-tauri/tauri.bundle.conf.json -c src-tauri/tauri.updater.conf.json
   ```

## Before retiring Outlook

Spec milestone 8: live in the app for two weeks.
