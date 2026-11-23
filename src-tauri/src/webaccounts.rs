//! Web accounts: Outlook on the web in a native web view over the main panel.
//! Each account has its own isolated storage so sign-ins never collide:
//! a WebView2 user data folder on Windows (and WebKitGTK data dir on Linux), and a
//! WKWebView data store identifier on macOS (macOS 14+).
//!
//! Views stay loaded in the background. A small injected script reports the Inbox
//! unread count and forwards the page's web notifications; the page may call only
//! those two commands (see capabilities/web-accounts.json).
//!
//! Fallback (spec §5): set MAIL_APP_WEB_MODE=window to give each web account its own
//! window instead of a child web view, if child-view isolation proves unreliable.
//! Linux (not a target; development only) always uses window mode.

use crate::state::AppState;
use crate::MAIN;
use mail_core::model::{Account, AccountKind};
use mail_core::Error;
use serde::Deserialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, WebviewWindowBuilder};

const SCRIPT: &str = include_str!("web_account.js");

fn label(account_id: &str) -> String {
    format!("web-{account_id}")
}

/// Linux (development only) always uses window mode: Tauri packs Linux child web views into
/// a GTK box, so they can't be positioned over the main panel.
fn window_mode() -> bool {
    cfg!(target_os = "linux") || std::env::var("MAIL_APP_WEB_MODE").map(|v| v == "window").unwrap_or(false)
}

/// Stable 16-byte store id per account (macOS WKWebsiteDataStore).
#[allow(dead_code)]
fn store_id(account_id: &str) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(format!("mail-web-store:{account_id}").as_bytes());
    let mut out = [0u8; 16];
    out.copy_from_slice(&d[..16]);
    out
}

fn url_for(a: &Account) -> Result<tauri::Url, Error> {
    let raw = a.web_url.clone().unwrap_or_else(|| "https://outlook.office.com/mail/".into());
    let u = tauri::Url::parse(&raw).map_err(|e| Error::Invalid(e.to_string()))?;
    if u.scheme() != "https" {
        return Err(Error::Invalid("Web accounts must use https".into()));
    }
    Ok(u)
}

fn find(app: &AppHandle, account_id: &str) -> Option<Webview> {
    app.get_webview(&label(account_id))
}

fn builder(app: &AppHandle, a: &Account) -> Result<WebviewBuilder<tauri::Wry>, Error> {
    let dir = app.state::<AppState>().svc.paths.webview_dir(&a.id);
    std::fs::create_dir_all(&dir)?;
    #[allow(unused_mut)]
    let mut b = WebviewBuilder::new(label(&a.id), WebviewUrl::External(url_for(a)?)).initialization_script(SCRIPT).data_directory(dir);
    #[cfg(target_os = "macos")]
    {
        b = b.data_store_identifier(store_id(&a.id));
    }
    Ok(b)
}

/// Create the account's web view (hidden) if it doesn't exist yet.
pub fn ensure(app: &AppHandle, a: &Account) -> Option<Webview> {
    if a.kind != AccountKind::Web {
        return None;
    }
    if let Some(w) = find(app, &a.id) {
        return Some(w);
    }
    if window_mode() {
        let dir = app.state::<AppState>().svc.paths.webview_dir(&a.id);
        let _ = std::fs::create_dir_all(&dir);
        #[allow(unused_mut)]
        let mut wb = WebviewWindowBuilder::new(app, label(&a.id), WebviewUrl::External(url_for(a).ok()?))
            .title(format!("{} · Outlook on the web", a.display_name))
            .inner_size(1200.0, 800.0)
            .visible(false)
            .initialization_script(SCRIPT)
            .data_directory(dir);
        #[cfg(target_os = "macos")]
        {
            wb = wb.data_store_identifier(store_id(&a.id));
        }
        return wb.build().ok().and_then(|w| app.get_webview(w.label()));
    }
    let main = app.get_window(MAIN)?;
    let b = builder(app, a).ok()?;
    match main.add_child(b, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)) {
        Ok(w) => {
            let _ = w.hide();
            Some(w)
        }
        Err(e) => {
            tracing::warn!("web view for {}: {e}", a.email);
            None
        }
    }
}

pub fn preload_all(app: &AppHandle) {
    let Some(s) = app.try_state::<AppState>() else { return };
    if s.demo {
        return;
    }
    for a in s.svc.list_accounts().unwrap_or_default() {
        ensure(app, &a);
    }
}

pub fn close(app: &AppHandle, account_id: &str) {
    if let Some(w) = find(app, account_id) {
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window(&label(account_id)) {
        let _ = w.close();
    }
}

#[derive(Deserialize, Clone, Copy)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Show one web account over the main panel (CSS-pixel bounds) and hide the others.
#[tauri::command]
pub async fn show_web_account(app: AppHandle, s: tauri::State<'_, AppState>, account_id: String, bounds: Bounds) -> Result<(), Error> {
    if s.demo {
        return Ok(());
    }
    let a = s.svc.get_account(&account_id)?;
    hide_all_except(&app, Some(&account_id));
    if window_mode() {
        if let Some(w) = app.get_webview_window(&label(&account_id)).or_else(|| ensure(&app, &a).and_then(|v| app.get_webview_window(v.label()))) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return Ok(());
    }
    let w = ensure(&app, &a).ok_or_else(|| Error::Other("Couldn't open Outlook on the web".into()))?;
    w.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| Error::Other(e.to_string()))?;
    w.set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0))).map_err(|e| Error::Other(e.to_string()))?;
    w.show().map_err(|e| Error::Other(e.to_string()))?;
    let _ = w.set_focus();
    Ok(())
}

fn hide_all_except(app: &AppHandle, keep: Option<&str>) {
    let keep = keep.map(label);
    for (l, w) in app.webviews() {
        if l.starts_with("web-") && Some(&l) != keep.as_ref() && app.get_webview_window(&l).is_none() {
            let _ = w.hide();
        }
    }
}

#[tauri::command]
pub async fn hide_web_accounts(app: AppHandle) -> Result<(), Error> {
    hide_all_except(&app, None);
    Ok(())
}

#[tauri::command]
pub async fn reload_web_account(app: AppHandle, account_id: String) -> Result<(), Error> {
    if let Some(w) = find(&app, &account_id) {
        w.reload().map_err(|e| Error::Other(e.to_string()))?;
    }
    Ok(())
}

fn account_of(webview: &Webview) -> Option<String> {
    webview.label().strip_prefix("web-").map(String::from)
}

/// Called by the injected script with the Inbox unread count (null when it can't be read).
#[tauri::command]
pub async fn web_account_report(webview: Webview, s: tauri::State<'_, AppState>, unread: Option<i64>) -> Result<(), Error> {
    let Some(id) = account_of(&webview) else { return Ok(()) };
    let unread = unread.filter(|n| (0..100_000).contains(n));
    if s.svc.set_web_unread(&id, unread)? {
        use tauri::Emitter;
        let _ = webview.app_handle().emit("web-account://unread", serde_json::json!({"accountId": id, "unread": unread}));
    }
    Ok(())
}

/// Called by the injected script when the page shows a web notification.
#[tauri::command]
pub async fn web_account_notify(webview: Webview, s: tauri::State<'_, AppState>, title: String, body: String) -> Result<(), Error> {
    let Some(id) = account_of(&webview) else { return Ok(()) };
    let a = s.svc.get_account(&id)?;
    if a.notifications {
        let title: String = title.chars().take(200).collect();
        let body: String = body.chars().take(500).collect();
        crate::events::notify(webview.app_handle(), &format!("{title} · {}", a.display_name), &body);
    }
    Ok(())
}
