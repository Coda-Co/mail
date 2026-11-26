//! Core events → window events, desktop notifications and the unread badge.

use crate::state::AppState;
use mail_core::model::{Account, MessageSummary};
use mail_core::EventSink;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub struct TauriEvents {
    app: AppHandle,
}

impl TauriEvents {
    pub fn new(app: AppHandle) -> Self {
        TauriEvents { app }
    }

    /// Emit off the caller's thread: the core may call us while it is mid-operation.
    fn later(&self, f: impl FnOnce(&AppHandle) + Send + 'static) {
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move { f(&app) });
    }
}

pub fn emit_accounts(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if let Ok(list) = state.svc.list_accounts() {
        let _ = app.emit("accounts://changed", &list);
        crate::tray::set_unread(app, list.iter().filter_map(|a| a.unread).sum());
    }
}

impl EventSink for TauriEvents {
    fn mail_changed(&self, account_ids: &[String]) {
        let ids = account_ids.to_vec();
        self.later(move |app| {
            let _ = app.emit("mail://changed", json!({ "accountIds": ids }));
            emit_accounts(app);
        });
    }
    fn accounts_changed(&self) {
        self.later(emit_accounts);
    }
    fn draft_changed(&self, draft_id: &str) {
        let id = draft_id.to_string();
        self.later(move |app| {
            let _ = app.emit("draft://changed", json!({ "draftId": id }));
        });
    }
    fn sync_status(&self) {
        self.later(|app| {
            if let Some(s) = app.try_state::<AppState>() {
                if let Ok(st) = s.sync_status() {
                    let _ = app.emit("sync://status", st);
                }
            }
        });
    }
    fn work_queued(&self, _account_id: &str) {
        // Sends and other changes go straight away, without waiting for a full sync.
        if let Some(s) = self.app.try_state::<AppState>() {
            s.outbox.notify_one();
        }
    }
    fn new_mail(&self, account: &Account, messages: &[MessageSummary]) {
        let account = account.clone();
        let messages = messages.to_vec();
        self.later(move |app| notify_new_mail(app, &account, &messages));
    }
}

fn notifications_on(app: &AppHandle) -> bool {
    app.try_state::<AppState>().and_then(|s| s.svc.settings().ok()).map(|s| s.notifications).unwrap_or(true)
}

/// Desktop notification labelled with the account.
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if !notifications_on(app) {
        return;
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

fn notify_new_mail(app: &AppHandle, account: &Account, messages: &[MessageSummary]) {
    match messages {
        [] => {}
        [m] => notify(app, &format!("{} · {}", m.from.display(), account.display_name), &m.subject),
        many => notify(app, &account.display_name, &format!("{} new messages", many.len())),
    }
}

/// Calendar reminders as desktop notifications.
pub async fn reminder_loop(app: AppHandle) {
    let mut since = chrono::Utc::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let now = chrono::Utc::now();
        let Some(state) = app.try_state::<AppState>() else { continue };
        if let Ok(due) = state.svc.due_reminders(since, now) {
            for e in due {
                let account = state.svc.get_account(&e.account_id).map(|a| a.display_name).unwrap_or_default();
                let when = chrono::DateTime::parse_from_rfc3339(&e.start).map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default();
                let place = if e.location.is_empty() { String::new() } else { format!(" · {}", e.location) };
                notify(&app, &format!("{} · {}", e.subject, account), &format!("{when}{place}"));
            }
        }
        since = now;
    }
}
