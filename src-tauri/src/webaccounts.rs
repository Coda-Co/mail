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
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
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
    let mut b = WebviewBuilder::new(label(&a.id), WebviewUrl::External(url_for(a)?))
        .initialization_script(SCRIPT)
        .data_directory(dir)
        .on_page_load(|w, p| on_page_load(w.app_handle(), w.label(), p.url(), p.event()));
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
            .on_page_load(|w, p| on_page_load(w.app_handle(), w.label(), p.url(), p.event()));
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

/// Per-account refresh schedule and outstanding requests (memory only).
#[derive(Default)]
pub struct WebCalendars {
    accounts: Mutex<HashMap<String, CalAccount>>,
    wake: tokio::sync::Notify,
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
}

fn is_outlook(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|h| OUTLOOK_HOSTS.contains(&h))
}

fn on_page_load(app: &AppHandle, label: &str, url: &tauri::Url, event: PageLoadEvent) {
    let (Some(id), Some(cal)) = (account_of_label(label), app.try_state::<WebCalendars>()) else { return };
    match event {
        PageLoadEvent::Started => cal.page_started(id),
        PageLoadEvent::Finished if is_outlook(url) => cal.page_loaded(id, Instant::now()),
        PageLoadEvent::Finished => {}
    }
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
    fn only_outlook_pages_count_as_loaded() {
        assert!(is_outlook(&tauri::Url::parse("https://outlook.office.com/mail/").unwrap()));
        assert!(is_outlook(&tauri::Url::parse("https://outlook.cloud.microsoft/calendar/view/workweek").unwrap()));
        assert!(!is_outlook(&tauri::Url::parse("https://login.microsoftonline.com/common").unwrap()));
        assert!(!is_outlook(&tauri::Url::parse("http://outlook.office.com/").unwrap()));
    }
}
