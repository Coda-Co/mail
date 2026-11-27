//! Web accounts: Outlook on the web in a native web view over the main panel.
//! Each account has its own isolated storage so sign-ins never collide:
//! a WebView2 user data folder on Windows (and WebKitGTK data dir on Linux), and a
//! WKWebView data store identifier on macOS (macOS 14+).
//!
//! Views stay loaded in the background. A small injected script reports the Inbox
//! unread count, forwards the page's web notifications and, when the account's calendar
//! toggle is on, answers the core's calendar requests (docs/WEB_CALENDAR.md). The page may
//! call only those three reporting commands (see capabilities/web-accounts.json), and can
//! read nothing from the app.
//!
//! Fallback (spec §5): set MAIL_APP_WEB_MODE=window to give each web account its own
//! window instead of a child web view, if child-view isolation proves unreliable.
//! Linux (not a target; development only) always uses window mode.

use crate::state::AppState;
use crate::MAIN;
use mail_core::model::{Account, AccountKind};
use mail_core::Error;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, WebviewWindowBuilder};

const SCRIPT: &str = include_str!("web_account.js");

/// Whether a web account is showing over the main panel (embedded mode only).
static EMBEDDED_SHOWN: AtomicBool = AtomicBool::new(false);

/// True while an embedded web account covers the main panel, so it, not the main
/// interface, should take keyboard focus when the window is activated.
pub fn embedded_shown() -> bool {
    EMBEDDED_SHOWN.load(Ordering::Relaxed)
}

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
    let mut b = WebviewBuilder::new(label(&a.id), WebviewUrl::External(url_for(a)?))
        .initialization_script(SCRIPT)
        .data_directory(dir)
        .on_page_load(|w, p| on_page_load(&w, p.url(), p.event()));
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
            .data_directory(dir)
            .on_page_load(|w, p| on_page_load(w.as_ref(), p.url(), p.event()));
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

/// Microsoft's sign-in hosts. Their session cookies carry the Outlook sign-in.
const LOGIN_URLS: [&str; 3] = ["https://login.microsoftonline.com/", "https://login.microsoft.com/", "https://login.live.com/"];
/// How long a rewritten sign-in cookie should last. Long enough to survive a restart (and a
/// few days away); not so long that a stale sign-in lingers for weeks.
const COOKIE_TTL_DAYS: i64 = 14;

/// Keep the Outlook sign-in across restarts by making its session cookies persistent.
///
/// After sign-in, Microsoft stores `ESTSAUTH` (and friends) as *session* cookies — no expiry.
/// WebView2 drops session cookies on restart, so MSAL's silent token renewal has no sign-in
/// session and falls back to an interactive password prompt: the user re-authenticates every
/// launch. Here we read those session cookies and write them back with a bounded future expiry,
/// so WebView2 keeps them on disk and the next launch signs in silently. Called whenever an
/// Outlook page finishes loading (see on_page_load), which is also when Microsoft has just
/// refreshed them. Persistent sign-in cookies (e.g. ESTSAUTHPERSISTENT) are left untouched.
///
/// Best-effort: cookie read/write can fail (view gone, API unsupported); we log and move on.
///
/// Reading cookies blocks until WebView2 answers on the main thread, so never call this from a
/// main-thread context (page-load hook, window/run events) — use persist_auth_cookies_async.
pub fn persist_auth_cookies(webview: &Webview) {
    use cookie::time::{Duration, OffsetDateTime};
    let expires = OffsetDateTime::now_utc() + Duration::days(COOKIE_TTL_DAYS);
    let mut kept = 0;
    for base in LOGIN_URLS {
        let Ok(url) = tauri::Url::parse(base) else { continue };
        let cookies = match webview.cookies_for_url(url) {
            Ok(c) => c,
            Err(e) => {
                tracing::debug!("read sign-in cookies from {base}: {e}");
                continue;
            }
        };
        for mut c in cookies {
            // Only rewrite cookies the browser would otherwise drop at shutdown.
            if c.expires().is_some_and(|e| e != cookie::Expiration::Session) {
                continue;
            }
            c.set_expires(expires);
            match webview.set_cookie(c) {
                Ok(()) => kept += 1,
                Err(e) => tracing::debug!("persist sign-in cookie: {e}"),
            }
        }
    }
    if kept > 0 {
        tracing::debug!("kept {kept} Outlook sign-in cookie(s) for {COOKIE_TTL_DAYS} day(s)");
    }
}

/// Close every web-account view before the app exits.
///
/// Each view runs its own WebView2 browser process holding an exclusive lock on its user
/// data folder (`EBWebView\lockfile`). If the app process dies without closing them, those
/// browser processes are orphaned and keep the lock; the next launch finds the profile
/// locked, falls back to a fresh empty profile and loses the sign-in — so the user has to
/// re-authenticate every restart. Closing the views here lets WebView2 release the lock and
/// delete `lockfile` cleanly, so the persisted cookies and MSAL token cache are reused next
/// time. Call this on every quit path (see RunEvent::ExitRequested in lib.rs).
pub fn close_all(app: &AppHandle) {
    let Some(s) = app.try_state::<AppState>() else { return };
    for a in s.svc.list_accounts().unwrap_or_default() {
        if a.kind == AccountKind::Web {
            // The sign-in cookies were already made persistent on each page load and on the
            // calendar schedule (persist_auth_cookies_async); we don't read cookies here, because
            // this runs on the main thread at exit and the cookie read would deadlock on it.
            close(app, &a.id);
        }
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
    EMBEDDED_SHOWN.store(true, Ordering::Relaxed);
    let _ = w.set_focus();
    Ok(())
}

fn hide_all_except(app: &AppHandle, keep: Option<&str>) {
    if keep.is_none() {
        EMBEDDED_SHOWN.store(false, Ordering::Relaxed);
    }
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
    // A hidden web view can keep keyboard focus (after Ctrl+1 from Outlook, say), leaving key
    // presses going nowhere; give it back to the interface.
    if !window_mode() {
        if let Some(w) = app.get_webview(crate::MAIN) {
            let _ = w.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn reload_web_account(app: AppHandle, account_id: String) -> Result<(), Error> {
    if let Some(w) = find(&app, &account_id) {
        w.reload().map_err(|e| Error::Other(e.to_string()))?;
    }
    Ok(())
}

/// The Outlook item id inside one of the app's public event ids (`<accountId>:<itemId>`), if
/// the event belongs to `account_id`. Outlook only knows the item id; sending the prefixed id
/// makes GetItem and the event link fail.
fn outlook_item_id<'a>(account_id: &str, event_id: &'a str) -> Option<&'a str> {
    mail_core::ids::split(event_id).ok().filter(|(acc, _)| *acc == account_id).map(|(_, raw)| raw)
}

/// Longest event id we'll put in a link (Outlook item ids are a few hundred characters).
const MAX_EVENT_ID: usize = 1024;

/// Outlook on the web's own link to one calendar item, on the same Outlook host as `base`:
/// `https://<host>/calendar/item/<id>`, with the item id fully percent-encoded (ids are base64,
/// so `+`, `/` and `=` must not reach the path as they are). None for a non-Outlook base or an
/// empty or oversized id.
fn event_url(base: &tauri::Url, event_id: &str) -> Option<tauri::Url> {
    if !is_outlook(base) || event_id.is_empty() || event_id.len() > MAX_EVENT_ID {
        return None;
    }
    let mut id = String::with_capacity(event_id.len() * 3);
    for b in event_id.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            id.push(b as char);
        } else {
            id.push_str(&format!("%{b:02X}"));
        }
    }
    tauri::Url::parse(&format!("https://{}/calendar/item/{id}", base.host_str()?)).ok()
}

/// Open one web-calendar event in the account's Outlook on the web view (the event's own page,
/// with its attendees and tracking), instead of just the account's start page. Navigates the
/// account's web view; the interface shows that view itself.
#[tauri::command]
pub async fn open_web_event(app: AppHandle, s: tauri::State<'_, AppState>, account_id: String, event_id: String) -> Result<(), Error> {
    if s.demo {
        return Ok(());
    }
    let a = s.svc.get_account(&account_id)?;
    let view = ensure(&app, &a).ok_or_else(|| Error::Other("Couldn't open Outlook on the web".into()))?;
    // Stay on the host the page is already signed in on (outlook.cloud.microsoft or office.com).
    let base = view.url().ok().filter(is_outlook).map_or_else(|| url_for(&a), Ok)?;
    let raw = outlook_item_id(&account_id, &event_id).ok_or_else(|| Error::Invalid("Not an event of this account".into()))?;
    let url = event_url(&base, raw).ok_or_else(|| Error::Invalid("Not an Outlook on the web event".into()))?;
    view.navigate(url).map_err(|e| Error::Other(e.to_string()))?;
    Ok(())
}

fn account_of_label(label: &str) -> Option<&str> {
    label.strip_prefix("web-").filter(|id| !id.is_empty())
}

fn account_of(webview: &Webview) -> Option<String> {
    account_of_label(webview.label()).map(String::from)
}

/// Called by the injected script with the Inbox unread count (null when it can't be read).
#[tauri::command]
pub async fn web_account_report(webview: Webview, s: tauri::State<'_, AppState>, unread: Option<i64>) -> Result<(), Error> {
    let Some(id) = account_of(&webview) else { return Ok(()) };
    let unread = unread.filter(|n| (0..100_000).contains(n));
    let old = s.svc.set_web_unread(&id, unread)?;
    if old != unread {
        use tauri::Emitter;
        let app = webview.app_handle();
        let _ = app.emit("web-account://unread", serde_json::json!({"accountId": id, "unread": unread}));
        // The count going up is new mail, unless the account's notifications are off (as for
        // other accounts); going down is mail read, whichever account it is.
        let notifies = s.svc.get_account(&id).is_ok_and(|a| a.notifications);
        let counted = if notifies { unread } else { unread.min(old) };
        if app.try_state::<crate::badge::NewMail>().is_some_and(|b| b.web_count(&id, old, counted)) {
            crate::tray::show_new_mail(app);
        }
    }
    Ok(())
}

/// Called by the injected script when Ctrl+1–9 (Cmd on macOS) is pressed in the page. The
/// main interface runs the shortcut as if pressed there (switch to Mail, Calendar, a mailbox).
#[tauri::command]
pub async fn web_account_shortcut(webview: Webview, digit: u8) -> Result<(), Error> {
    if account_of(&webview).is_none() || !(1..=9).contains(&digit) {
        return Ok(());
    }
    use tauri::Emitter;
    let _ = webview.app_handle().emit("web-account://shortcut", serde_json::json!({ "digit": digit }));
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

// ---------------------------------------------------------------- calendar (docs/WEB_CALENDAR.md)
//
// The core owns the schedule: it asks the page for a date range with a one-time request id,
// and the page answers with `web_account_calendar_report`. Reports without a matching
// outstanding request are dropped, so the page can only answer what it was asked, for its
// own account.

/// Between refreshes of one account.
const CAL_REFRESH_EVERY: Duration = Duration::from_secs(10 * 60);
/// Opening Calendar refreshes at most this often.
const CAL_OPEN_GAP: Duration = Duration::from_secs(60);
/// Let Outlook on the web start up after a page load before asking.
const CAL_AFTER_LOAD: Duration = Duration::from_secs(15);
/// A request with no answer by then is given up (the page itself times out after 30 s).
const CAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

const OUTLOOK_HOSTS: [&str; 4] = ["outlook.cloud.microsoft", "outlook.office.com", "outlook.office365.com", "outlook.live.com"];

#[derive(Debug, Clone, PartialEq)]
struct CalRequest {
    id: String,
    start: String,
    end: String,
    sent: Instant,
}

#[derive(Debug, Default)]
struct CalAccount {
    /// An Outlook page finished loading in the account's view.
    loaded: bool,
    next_at: Option<Instant>,
    last_sent: Option<Instant>,
    pending: Option<CalRequest>,
}

/// The page's answer to one on-demand attendee request: the attendee list, or an error code.
type AttendeeReply = std::result::Result<Vec<serde_json::Value>, String>;

/// Per-account refresh schedule and outstanding requests (memory only).
#[derive(Default)]
pub struct WebCalendars {
    accounts: Mutex<HashMap<String, CalAccount>>,
    wake: tokio::sync::Notify,
    /// Outstanding attendee fetches, by one-time request id (see `fetch_web_event_attendees`).
    attendee_waiters: Mutex<HashMap<String, tokio::sync::oneshot::Sender<AttendeeReply>>>,
}

impl WebCalendars {
    fn with<T>(&self, account_id: &str, f: impl FnOnce(&mut CalAccount) -> T) -> T {
        let mut map = self.accounts.lock().unwrap_or_else(|p| p.into_inner());
        f(map.entry(account_id.to_string()).or_default())
    }

    fn page_started(&self, account_id: &str) {
        self.with(account_id, |a| {
            a.loaded = false;
            a.pending = None;
        });
    }

    fn page_loaded(&self, account_id: &str, now: Instant) {
        self.with(account_id, |a| {
            a.loaded = true;
            let soon = now + CAL_AFTER_LOAD;
            a.next_at = Some(a.next_at.map_or(soon, |t| t.min(soon)));
        });
        self.wake.notify_one();
    }

    /// Refresh as soon as the page is ready (the toggle was just turned on).
    pub fn request_now(&self, account_id: &str, now: Instant) {
        self.with(account_id, |a| a.next_at = Some(now));
        self.wake.notify_one();
    }

    /// The user opened Calendar: refresh unless one was sent in the last minute.
    fn calendar_opened(&self, account_id: &str, now: Instant) {
        let due = self.with(account_id, |a| {
            let recent = a.last_sent.is_some_and(|t| now.duration_since(t) < CAL_OPEN_GAP);
            if !recent {
                a.next_at = Some(now);
            }
            !recent
        });
        if due {
            self.wake.notify_one();
        }
    }

    pub fn forget(&self, account_id: &str) {
        self.accounts.lock().unwrap_or_else(|p| p.into_inner()).remove(account_id);
    }

    /// If a refresh is due, record a new outstanding request and return it.
    fn begin(&self, account_id: &str, now: Instant, start: &str, end: &str) -> Option<CalRequest> {
        self.with(account_id, |a| {
            let waiting = a.pending.as_ref().is_some_and(|p| now.duration_since(p.sent) < CAL_REQUEST_TIMEOUT);
            if !a.loaded || waiting || a.next_at.is_none_or(|t| t > now) {
                return None;
            }
            let req = CalRequest { id: uuid::Uuid::new_v4().simple().to_string(), start: start.into(), end: end.into(), sent: now };
            a.pending = Some(req.clone());
            a.last_sent = Some(now);
            a.next_at = Some(now + CAL_REFRESH_EVERY);
            Some(req)
        })
    }

    /// The requested range for a report, if it answers this account's outstanding request.
    /// Each request is answered once.
    fn take(&self, account_id: &str, request_id: &str) -> Option<(String, String)> {
        let mut map = self.accounts.lock().unwrap_or_else(|p| p.into_inner());
        let a = map.get_mut(account_id)?;
        if a.pending.as_ref()?.id != request_id {
            return None;
        }
        a.pending.take().map(|p| (p.start, p.end))
    }

    /// Register an outstanding attendee request and return the receiver its reply will arrive on.
    fn await_attendees(&self, request_id: &str) -> tokio::sync::oneshot::Receiver<AttendeeReply> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.attendee_waiters.lock().unwrap_or_else(|p| p.into_inner()).insert(request_id.to_string(), tx);
        rx
    }

    /// Deliver the page's reply to the matching attendee request. Replies without a waiting
    /// request (unknown or already-answered id) are dropped.
    fn fulfil_attendees(&self, request_id: &str, reply: AttendeeReply) {
        if let Some(tx) = self.attendee_waiters.lock().unwrap_or_else(|p| p.into_inner()).remove(request_id) {
            let _ = tx.send(reply);
        }
    }

    /// Give up on an attendee request (timed out, or the view was gone), freeing its slot.
    fn drop_attendees(&self, request_id: &str) {
        self.attendee_waiters.lock().unwrap_or_else(|p| p.into_inner()).remove(request_id);
    }
}

fn is_outlook(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|h| OUTLOOK_HOSTS.contains(&h))
}

fn on_page_load(webview: &Webview, url: &tauri::Url, event: PageLoadEvent) {
    let app = webview.app_handle();
    let (Some(id), Some(cal)) = (account_of(webview), app.try_state::<WebCalendars>()) else { return };
    match event {
        PageLoadEvent::Started => cal.page_started(&id),
        PageLoadEvent::Finished if is_outlook(url) => {
            cal.page_loaded(&id, Instant::now());
            // Signed in and loaded: keep the sign-in cookies so the next restart doesn't re-prompt.
            // Reading cookies blocks on a WebView2 callback that runs on this (the main) thread, so
            // it must not run here — do it on a worker instead (see persist_auth_cookies_async).
            persist_auth_cookies_async(app.clone(), id);
        }
        PageLoadEvent::Finished => {}
    }
}

/// Persist the sign-in cookies off the main thread.
///
/// `Webview::cookies_for_url` blocks until WebView2 answers on the main thread, so calling it
/// from a main-thread context (a page-load hook, a window event) deadlocks. This hops onto a
/// blocking worker, which is free to wait while the main thread keeps pumping the callback.
fn persist_auth_cookies_async(app: AppHandle, account_id: String) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(w) = find(&app, &account_id) {
            persist_auth_cookies(&w);
        }
    });
}

/// Persist every web account's sign-in cookies, then run `done`.
///
/// For the clean-quit path: the final cookie values (including any Microsoft refreshed during the
/// run) must be made persistent before the views are torn down, or the next launch re-prompts.
/// Runs on a worker so the main event loop stays free to answer the cookie reads (see
/// persist_auth_cookies); `done` fires on the worker once every account is handled.
pub fn persist_all_then(app: AppHandle, done: impl FnOnce() + Send + 'static) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(s) = app.try_state::<AppState>() {
            for a in s.svc.list_accounts().unwrap_or_default() {
                if a.kind == AccountKind::Web {
                    if let Some(w) = find(&app, &a.id) {
                        persist_auth_cookies(&w);
                    }
                }
            }
        }
        done();
    });
}

/// The toggle was turned on: ask the page right away (or as soon as it has loaded).
pub fn calendar_turned_on(app: &AppHandle, account_id: &str) {
    if let Some(cal) = app.try_state::<WebCalendars>() {
        cal.request_now(account_id, Instant::now());
    }
}

/// Asks each web account with the calendar toggle on for its events, on schedule.
pub async fn calendar_loop(app: AppHandle) {
    loop {
        if let Some(cal) = app.try_state::<WebCalendars>() {
            let _ = tokio::time::timeout(Duration::from_secs(30), cal.wake.notified()).await;
        } else {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        let (Some(s), Some(cal)) = (app.try_state::<AppState>(), app.try_state::<WebCalendars>()) else { continue };
        if s.demo {
            continue;
        }
        // Keep each web account's sign-in cookies persistent, in case Microsoft refreshed them to
        // new session cookies during a long run. This loop is off the main thread, so the blocking
        // cookie read is safe here (unlike the page-load hook or the exit handler).
        for a in s.svc.list_accounts().unwrap_or_default() {
            if a.kind == AccountKind::Web {
                if let Some(w) = find(&app, &a.id) {
                    persist_auth_cookies(&w);
                }
            }
        }
        let Ok(accounts) = s.svc.web_calendar_accounts() else { continue };
        let (start, end) = mail_core::webcal::window();
        for a in accounts {
            let Some(view) = find(&app, &a.id) else { continue };
            let Some(req) = cal.begin(&a.id, Instant::now(), &start, &end) else { continue };
            let js = format!(
                "window.__mailCalendarFetch && window.__mailCalendarFetch({}, {}, {})",
                serde_json::Value::from(req.start),
                serde_json::Value::from(req.end),
                serde_json::Value::from(req.id)
            );
            if let Err(e) = view.eval(js) {
                tracing::debug!("web calendar request for {}: {e}", a.id);
            }
        }
    }
}

/// The main window opened Calendar: refresh web calendars at most once a minute.
#[tauri::command]
pub async fn refresh_web_calendars(app: AppHandle, s: tauri::State<'_, AppState>) -> Result<(), Error> {
    if s.demo {
        return Ok(());
    }
    if let Some(cal) = app.try_state::<WebCalendars>() {
        for a in s.svc.web_calendar_accounts()? {
            cal.calendar_opened(&a.id, Instant::now());
        }
    }
    Ok(())
}

/// Called by the injected script with the events for a range the core asked for. Unsolicited
/// reports (no matching request id) and reports from other views are dropped. Nothing is
/// returned to the page.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn web_account_calendar_report(
    webview: Webview,
    s: tauri::State<'_, AppState>,
    cal: tauri::State<'_, WebCalendars>,
    request_id: String,
    start: String,
    end: String,
    events: Vec<serde_json::Value>,
    error: Option<String>,
) -> Result<(), Error> {
    let Some(id) = account_of(&webview) else { return Ok(()) };
    let Some((range_start, range_end)) = cal.take(&id, &request_id) else { return Ok(()) };
    let report = mail_core::webcal::Report { start, end, events, error };
    if let Err(e) = s.svc.store_web_calendar(&id, &range_start, &range_end, &report) {
        tracing::debug!("web calendar report for {id}: {e}");
    }
    Ok(())
}

/// How long to wait for the page to answer an attendee request before giving up.
const ATTENDEE_TIMEOUT: Duration = Duration::from_secs(25);

/// Fetch one web-calendar event's attendees on demand (when the event is opened). The calendar
/// view doesn't carry attendee lists, so the page asks the server for just this event's
/// attendees (`__mailEventAttendees` → GetItem) and answers with a one-time request id. Returns
/// the attendees (name, email, response), validated and capped the same as calendar events.
#[tauri::command]
pub async fn fetch_web_event_attendees(app: AppHandle, s: tauri::State<'_, AppState>, cal: tauri::State<'_, WebCalendars>, account_id: String, event_id: String) -> Result<Vec<mail_core::model::Attendee>, Error> {
    if s.demo {
        return Ok(Vec::new());
    }
    let Some(raw) = outlook_item_id(&account_id, &event_id) else { return Ok(Vec::new()) };
    let Some(view) = find(&app, &account_id) else { return Ok(Vec::new()) };
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let rx = cal.await_attendees(&request_id);
    let js = format!(
        "window.__mailEventAttendees && window.__mailEventAttendees({}, {})",
        serde_json::Value::from(raw),
        serde_json::Value::from(request_id.clone())
    );
    if let Err(e) = view.eval(js) {
        cal.drop_attendees(&request_id);
        tracing::debug!("request web event attendees for {account_id}: {e}");
        return Ok(Vec::new());
    }
    match tokio::time::timeout(ATTENDEE_TIMEOUT, rx).await {
        Ok(Ok(Ok(list))) => Ok(mail_core::webcal::parse_attendees(&list)),
        // Page reported an error, the sender was dropped, or we timed out: no attendees, no fuss.
        // The page's short error code is logged so a change on Outlook's side can be spotted.
        Ok(Ok(Err(code))) => {
            tracing::info!("web event attendees for {account_id}: page reported {code}");
            Ok(Vec::new())
        }
        _ => {
            cal.drop_attendees(&request_id);
            Ok(Vec::new())
        }
    }
}

/// The page's answer to a `fetch_web_event_attendees` request. Answers without a matching
/// outstanding request (unknown or already-answered id) are dropped, so the page can only answer
/// what it was asked. Nothing is returned to the page.
#[tauri::command]
pub async fn web_account_event_attendees_report(
    webview: Webview,
    cal: tauri::State<'_, WebCalendars>,
    request_id: String,
    attendees: Vec<serde_json::Value>,
    error: Option<String>,
) -> Result<(), Error> {
    // Only a web-account view may answer (the report comes from the injected script).
    if account_of(&webview).is_none() {
        return Ok(());
    }
    let reply = match error {
        Some(code) => Err(code),
        None => Ok(attendees),
    };
    cal.fulfil_attendees(&request_id, reply);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_views_labelled_web_are_accounts() {
        assert_eq!(account_of_label("web-acc123"), Some("acc123"));
        assert_eq!(account_of_label("main"), None);
        assert_eq!(account_of_label("compose-1"), None);
        assert_eq!(account_of_label("web-"), None);
    }

    #[test]
    fn unsolicited_and_repeated_reports_are_dropped() {
        let cal = WebCalendars::default();
        let t0 = Instant::now();
        assert_eq!(cal.take("a", "anything"), None, "nothing asked yet");
        cal.page_loaded("a", t0);
        cal.request_now("a", t0);
        let req = cal.begin("a", t0, "S", "E").unwrap();
        assert_eq!(cal.take("a", "guess"), None, "unknown request id");
        assert_eq!(cal.take("b", &req.id), None, "another account's request id");
        assert_eq!(cal.take("a", &req.id), Some(("S".into(), "E".into())));
        assert_eq!(cal.take("a", &req.id), None, "answered once");
    }

    #[test]
    fn schedule() {
        let cal = WebCalendars::default();
        let t0 = Instant::now();
        cal.request_now("a", t0);
        assert!(cal.begin("a", t0, "S", "E").is_none(), "not before the page has loaded");
        cal.page_loaded("a", t0);
        assert!(cal.begin("a", t0, "S", "E").is_some(), "turned on: right away once loaded");
        let t1 = t0 + Duration::from_secs(5);
        assert!(cal.begin("a", t1, "S", "E").is_none(), "one at a time, and not due");
        cal.calendar_opened("a", t1);
        assert!(cal.begin("a", t1, "S", "E").is_none(), "opening Calendar within a minute doesn't ask again");
        let t2 = t0 + CAL_REQUEST_TIMEOUT + Duration::from_secs(1);
        cal.calendar_opened("a", t2);
        assert!(cal.begin("a", t2, "S", "E").is_some(), "unanswered request timed out; opening Calendar asks again");
        let t3 = t2 + CAL_REFRESH_EVERY;
        assert!(cal.begin("a", t3 - Duration::from_secs(1), "S", "E").is_none());
        assert!(cal.begin("a", t3, "S", "E").is_some(), "every 10 minutes");

        // A new page load drops the outstanding request and waits for the page to start.
        cal.page_started("a");
        let t4 = t3 + Duration::from_secs(1);
        cal.page_loaded("a", t4);
        assert!(cal.begin("a", t4, "S", "E").is_none());
        assert!(cal.begin("a", t4 + CAL_AFTER_LOAD, "S", "E").is_some());
    }

    #[test]
    fn event_links_stay_on_the_outlook_host() {
        let base = tauri::Url::parse("https://outlook.cloud.microsoft/mail/inbox").unwrap();
        let u = event_url(&base, "AAMkAD+a/b=").unwrap();
        assert_eq!(u.as_str(), "https://outlook.cloud.microsoft/calendar/item/AAMkAD%2Ba%2Fb%3D");
        assert!(event_url(&base, "").is_none());
        assert!(event_url(&base, &"a".repeat(MAX_EVENT_ID + 1)).is_none());
        assert!(event_url(&tauri::Url::parse("https://evil.example/").unwrap(), "x").is_none());
    }

    #[test]
    fn public_event_ids_are_unwrapped_for_outlook() {
        assert_eq!(outlook_item_id("acc1", "acc1:AAMkAD+a/b="), Some("AAMkAD+a/b="));
        assert_eq!(outlook_item_id("acc1", "acc2:AAMk"), None, "another account's event");
        assert_eq!(outlook_item_id("acc1", "AAMk"), None);
    }

    #[test]
    fn only_outlook_pages_count_as_loaded() {
        assert!(is_outlook(&tauri::Url::parse("https://outlook.office.com/mail/").unwrap()));
        assert!(is_outlook(&tauri::Url::parse("https://outlook.cloud.microsoft/calendar/view/workweek").unwrap()));
        assert!(!is_outlook(&tauri::Url::parse("https://login.microsoftonline.com/common").unwrap()));
        assert!(!is_outlook(&tauri::Url::parse("http://outlook.office.com/").unwrap()));
    }
}
