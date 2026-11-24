//! Tauri commands: one per `MailApi` method in src/api/types.ts.
//! All are async so database work never runs on the UI thread.

use crate::state::AppState;
use crate::MAIN;
use mail_core::auth::{self, SignIn, Tokens};
use mail_core::graph::GraphClient;
use mail_core::model::*;
use mail_core::sync::Syncer;
use mail_core::{ids, Error};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type R<T> = Result<T, Error>;

// ---------------------------------------------------------------- accounts

#[tauri::command]
pub async fn me(s: State<'_, AppState>) -> R<Me> {
    s.svc.me()
}

#[tauri::command]
pub async fn list_accounts(s: State<'_, AppState>) -> R<Vec<Account>> {
    s.svc.list_accounts()
}

/// Sign in with Microsoft in the system browser. If the tenant needs admin approval,
/// return what the interface needs to offer: admin consent, a message for the admin, or web mode.
#[tauri::command]
pub async fn add_account(app: AppHandle, s: State<'_, AppState>, email: String) -> R<AddAccountResult> {
    sign_in_and_add(&app, &s, email.trim()).await
}

async fn sign_in_and_add(app: &AppHandle, s: &AppState, email: &str) -> R<AddAccountResult> {
    if !mail_core::service::valid_email(email) {
        return Ok(AddAccountResult::Error { message: "Enter a full email address".into() });
    }
    if s.demo {
        return Ok(AddAccountResult::Error { message: "Sign-in is not available in the demo".into() });
    }
    let opener = app.clone();
    let outcome = auth::sign_in(&s.http, &s.auth, email, move |url| opener.opener().open_url(url, None::<&str>).map_err(|e| Error::Other(e.to_string()))).await;
    match outcome {
        Ok(SignIn::Success(t)) => {
            let addr = t.claims.preferred_username.clone().filter(|u| u.contains('@')).unwrap_or_else(|| email.to_string());
            // Name the account after the organisation (User.Read allows this).
            let tmp = GraphClient::new(s.http.clone(), s.graph_base.clone(), Arc::new(Tokens::fixed(&t.access_token)));
            let org = tmp.get("/organization?$select=displayName").await.ok().and_then(|v| v["value"][0]["displayName"].as_str().map(String::from)).unwrap_or_default();
            let tenant = t.claims.tid.clone();
            let home = match (&t.claims.oid, &t.claims.tid) {
                (Some(o), Some(tid)) => Some(format!("{o}.{tid}")),
                _ => None,
            };
            let account = s.svc.add_graph_account(&addr, &org, tenant, home)?;
            if let Some(rt) = &t.refresh_token {
                s.tokens.set(&account.id, rt)?;
            }
            s.tokens_for(&account).seed(&t).await;
            crate::webaccounts::close(app, &account.id);
            if s.svc.me()?.name.is_empty() {
                if let Some(n) = &t.claims.name {
                    s.svc.set_me(&Me { name: n.clone(), email: addr.clone() })?;
                }
            }
            s.wake.notify_one();
            Ok(AddAccountResult::Added { account: s.svc.get_account(&account.id)? })
        }
        Ok(SignIn::NeedsAdmin { code, .. }) => {
            let domain = email.split('@').nth(1).unwrap_or("organizations");
            let url = auth::admin_consent_url(&s.auth, domain, "http://localhost");
            Ok(AddAccountResult::NeedsAdminApproval {
                email: email.to_string(),
                tenant_id: None,
                error_code: code,
                request_message: auth::admin_request_message(email, &url, &s.auth.security_note_url),
                admin_consent_url: url,
            })
        }
        Ok(SignIn::Cancelled) => Ok(AddAccountResult::Cancelled),
        Err(e) => Ok(AddAccountResult::Error { message: e.to_string() }),
    }
}

#[tauri::command]
pub async fn add_web_account(app: AppHandle, s: State<'_, AppState>, email: String, display_name: String) -> R<Account> {
    let a = s.svc.add_web_account(&email, &display_name)?;
    crate::webaccounts::ensure(&app, &a);
    Ok(a)
}

/// "Request approval": try Graph sign-in again for a web account.
#[tauri::command]
pub async fn upgrade_web_account(app: AppHandle, s: State<'_, AppState>, account_id: String) -> R<AddAccountResult> {
    let a = s.svc.get_account(&account_id)?;
    sign_in_and_add(&app, &s, &a.email).await
}

#[tauri::command]
pub async fn update_account(s: State<'_, AppState>, account_id: String, patch: AccountPatch) -> R<Account> {
    s.svc.update_account(&account_id, &patch)
}

/// Deletes the account's database, cache, web view storage and tokens.
#[tauri::command]
pub async fn remove_account(app: AppHandle, s: State<'_, AppState>, account_id: String) -> R<()> {
    crate::webaccounts::close(&app, &account_id);
    s.forget_tokens(&account_id);
    // Give a closed web view a moment to release its storage folder.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    s.svc.remove_account(&account_id)
}

// ---------------------------------------------------------------- mail

#[tauri::command]
pub async fn list_folders(s: State<'_, AppState>, account_id: Option<String>) -> R<Vec<Folder>> {
    s.svc.list_folders(account_id.as_deref())
}

#[tauri::command]
pub async fn list_messages(s: State<'_, AppState>, scope: ViewScope, limit: i64, offset: i64) -> R<Vec<MessageSummary>> {
    s.svc.list_messages(&scope, limit, offset)
}

/// Local first. Headers outside the offline window get their body fetched; attachments and
/// inline images are fetched in the background and announced with mail://changed.
#[tauri::command]
pub async fn get_thread(s: State<'_, AppState>, message_id: String) -> R<Thread> {
    let stored = s.svc.stored_message(&message_id)?;
    if !stored.has_body && !s.demo {
        let account = s.svc.get_account(&stored.message.summary.account_id)?;
        if let Ok(g) = s.graph(&account) {
            let _ = Syncer::new(&s.svc, &g, account).fetch_message(&stored.raw_id).await;
        }
    }
    let thread = s.svc.get_thread(&message_id)?;
    if !s.demo {
        let svc = s.svc.clone();
        let factory = s.client_factory();
        let targets: Vec<(String, String)> = thread.messages.iter().filter_map(|m| ids::split(&m.summary.id).ok().map(|(a, r)| (a.to_string(), r.to_string()))).collect();
        tauri::async_runtime::spawn(async move {
            let mut changed = false;
            for (acc, raw) in targets {
                let Ok(account) = svc.get_account(&acc) else { continue };
                let Ok(g) = factory(&account) else { continue };
                if let Ok(true) = Syncer::new(&svc, &g, account).ensure_attachments(&raw).await {
                    changed = true;
                }
            }
            if changed {
                svc.events().mail_changed(&[]);
            }
        });
    }
    Ok(thread)
}

#[tauri::command]
pub async fn get_message(s: State<'_, AppState>, message_id: String) -> R<Message> {
    s.svc.get_message(&message_id)
}

#[tauri::command]
pub async fn mark_read(s: State<'_, AppState>, ids: Vec<String>, read: bool) -> R<()> {
    s.svc.mark_read(&ids, read)
}

#[tauri::command]
pub async fn set_flag(s: State<'_, AppState>, ids: Vec<String>, flagged: bool) -> R<()> {
    s.svc.set_flag(&ids, flagged)
}

#[tauri::command]
pub async fn archive(s: State<'_, AppState>, ids: Vec<String>) -> R<()> {
    s.svc.archive(&ids)
}

#[tauri::command]
pub async fn delete_messages(s: State<'_, AppState>, ids: Vec<String>) -> R<()> {
    s.svc.delete_messages(&ids)
}

#[tauri::command]
pub async fn move_messages(s: State<'_, AppState>, ids: Vec<String>, folder_id: String) -> R<()> {
    s.svc.move_messages(&ids, &folder_id)
}

#[tauri::command]
pub async fn allow_remote_images(s: State<'_, AppState>, sender_email: String) -> R<()> {
    s.svc.allow_remote_images(&sender_email)
}

#[tauri::command]
pub async fn show_remote_images_once(s: State<'_, AppState>, message_id: String) -> R<Message> {
    s.svc.show_remote_images_once(&message_id)
}

/// Download on demand (cached), then open with the system's default app.
#[tauri::command]
pub async fn open_attachment(app: AppHandle, s: State<'_, AppState>, message_id: String, attachment_id: String) -> R<()> {
    let (acc, raw) = ids::split(&message_id)?;
    let account = s.svc.get_account(acc)?;
    let g = s.graph(&account)?;
    let path = Syncer::new(&s.svc, &g, account).download_attachment(raw, &attachment_id).await?;
    app.opener().open_path(path, None::<&str>).map_err(|e| Error::Other(e.to_string()))
}

// ---------------------------------------------------------------- drafts

#[tauri::command]
pub async fn create_draft(s: State<'_, AppState>, req: CreateDraftRequest) -> R<Draft> {
    s.svc.create_draft(&req)
}

#[tauri::command]
pub async fn get_draft(s: State<'_, AppState>, draft_id: String) -> R<Draft> {
    s.svc.get_draft(&draft_id)
}

#[tauri::command]
pub async fn update_draft(s: State<'_, AppState>, draft: Draft) -> R<Draft> {
    s.svc.update_draft(&draft)
}

#[tauri::command]
pub async fn change_draft_account(app: AppHandle, s: State<'_, AppState>, draft_id: String, account_id: String) -> R<Draft> {
    let d = s.svc.change_draft_account(&draft_id, &account_id)?;
    // A pop-out window keeps working: tell every window the id changed.
    let _ = app.emit("draft://changed", json!({ "draftId": draft_id, "newDraftId": d.id }));
    Ok(d)
}

#[tauri::command]
pub async fn add_attachment(app: AppHandle, s: State<'_, AppState>, draft_id: String) -> R<Draft> {
    let picked = app.dialog().file().set_title("Attach files").blocking_pick_files();
    let mut d = s.svc.get_draft(&draft_id)?;
    for f in picked.unwrap_or_default() {
        let path = f.into_path().map_err(|e| Error::Other(e.to_string()))?;
        d = s.svc.add_attachment(&draft_id, &path)?;
    }
    Ok(d)
}

#[tauri::command]
pub async fn remove_attachment(s: State<'_, AppState>, draft_id: String, attachment_id: String) -> R<Draft> {
    s.svc.remove_attachment(&draft_id, &attachment_id)
}

#[tauri::command]
pub async fn discard_draft(app: AppHandle, s: State<'_, AppState>, draft_id: String) -> R<()> {
    s.svc.discard_draft(&draft_id)?;
    close_popout(&app, &draft_id);
    Ok(())
}

#[tauri::command]
pub async fn send_draft(app: AppHandle, s: State<'_, AppState>, draft_id: String) -> R<Draft> {
    let d = s.svc.send_draft(&draft_id)?;
    close_popout(&app, &draft_id);
    Ok(d)
}

// ---------------------------------------------------------------- search & people

#[tauri::command]
pub async fn search(s: State<'_, AppState>, query: SearchQuery) -> R<SearchResult> {
    s.svc.search(&query)
}

/// Extend results beyond the offline window.
#[tauri::command]
pub async fn search_server(s: State<'_, AppState>, query: SearchQuery) -> R<SearchResult> {
    let local = s.svc.search(&query)?;
    if s.demo {
        return Ok(SearchResult { from_server: true, ..local });
    }
    let mut found = vec![];
    for a in s.svc.graph_accounts()? {
        if query.account_id.as_deref().is_some_and(|x| x != a.id) || query.scope.account_id.as_deref().is_some_and(|x| x != a.id) {
            continue;
        }
        let g = s.graph(&a)?;
        match Syncer::new(&s.svc, &g, a.clone()).search_server(&query).await {
            Ok(ids) => found.extend(ids),
            Err(e) if e.is_network() => return Err(Error::Network("You're offline. Showing what's on this device.".into())),
            Err(e) => return Err(e),
        }
    }
    mail_core::sync::merge_search(&s.svc, local, &found)
}

#[tauri::command]
pub async fn list_people(s: State<'_, AppState>, query: String, limit: usize) -> R<Vec<Person>> {
    s.svc.list_people(&query, limit)
}

#[tauri::command]
pub async fn get_person(s: State<'_, AppState>, email: String) -> R<Option<Person>> {
    s.svc.get_person(&email)
}

// ---------------------------------------------------------------- calendar

#[tauri::command]
pub async fn list_calendars(s: State<'_, AppState>) -> R<Vec<CalendarInfo>> {
    s.svc.list_calendars()
}

#[tauri::command]
pub async fn set_calendar_visible(s: State<'_, AppState>, calendar_id: String, visible: bool) -> R<()> {
    s.svc.set_calendar_visible(&calendar_id, visible)
}

#[tauri::command]
pub async fn list_events(s: State<'_, AppState>, start: String, end: String) -> R<Vec<CalendarEvent>> {
    s.svc.list_events(&start, &end)
}

#[tauri::command]
pub async fn agenda(s: State<'_, AppState>, days: i64) -> R<Vec<AgendaDay>> {
    s.svc.agenda(days)
}

#[tauri::command]
pub async fn create_event(s: State<'_, AppState>, input: EventInput) -> R<CalendarEvent> {
    s.svc.create_event(&input)
}

#[tauri::command]
pub async fn update_event(s: State<'_, AppState>, event_id: String, input: EventInput) -> R<CalendarEvent> {
    s.svc.update_event(&event_id, &input)
}

#[tauri::command]
pub async fn respond_event(s: State<'_, AppState>, event_id: String, response: EventResponse) -> R<CalendarEvent> {
    s.svc.respond_event(&event_id, response)
}

#[tauri::command]
pub async fn delete_event(s: State<'_, AppState>, event_id: String) -> R<()> {
    s.svc.delete_event(&event_id)
}

// ---------------------------------------------------------------- signatures & settings

#[tauri::command]
pub async fn list_signatures(s: State<'_, AppState>, account_id: Option<String>) -> R<Vec<Signature>> {
    s.svc.list_signatures(account_id.as_deref())
}

#[tauri::command]
pub async fn save_signature(s: State<'_, AppState>, signature: Signature) -> R<Signature> {
    s.svc.save_signature(&signature)
}

#[tauri::command]
pub async fn delete_signature(s: State<'_, AppState>, signature_id: String) -> R<()> {
    s.svc.delete_signature(&signature_id)
}

#[tauri::command]
pub async fn get_settings(s: State<'_, AppState>) -> R<Settings> {
    s.svc.settings()
}

#[tauri::command]
pub async fn update_settings(s: State<'_, AppState>, patch: SettingsPatch) -> R<Settings> {
    s.svc.update_settings(&patch)
}

#[tauri::command]
pub async fn sync_now(s: State<'_, AppState>, account_id: Option<String>) -> R<()> {
    let _ = account_id;
    s.wake.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn sync_status(s: State<'_, AppState>) -> R<SyncStatus> {
    s.sync_status()
}

#[tauri::command]
pub async fn disk_encryption() -> R<DiskEncryption> {
    Ok(tauri::async_runtime::spawn_blocking(mail_core::disk::check).await.unwrap_or(DiskEncryption::Unknown))
}

/// How to connect an MCP client: the bundled mail-mcp sidecar and this app's data folder.
#[tauri::command]
pub async fn mcp_info(app: AppHandle, s: State<'_, AppState>) -> R<McpInfo> {
    let exe = std::env::current_exe()?;
    let name = if cfg!(windows) { "mail-mcp.exe" } else { "mail-mcp" };
    let command = exe.parent().map(|p| p.join(name)).unwrap_or_else(|| name.into()).to_string_lossy().to_string();
    let data = app.path().app_data_dir().map_err(|e| Error::Other(e.to_string()))?.to_string_lossy().to_string();
    let args = vec!["--data-dir".to_string(), data];
    let snippet = serde_json::to_string_pretty(&json!({"mcpServers": {"mail": {"command": command, "args": args}}}))?;
    Ok(McpInfo { enabled: s.svc.settings()?.mcp_enabled, command, args, config_snippet: snippet })
}

// ---------------------------------------------------------------- windows

fn window_label(prefix: &str, id: &str) -> String {
    use sha2::{Digest, Sha256};
    let h: String = Sha256::digest(id.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("{prefix}-{h}")
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum PopKind {
    Message,
    Draft,
}

/// Open a message or draft in its own window.
#[tauri::command]
pub async fn pop_out(app: AppHandle, s: State<'_, AppState>, kind: PopKind, id: String) -> R<()> {
    let (label, route, title) = match kind {
        PopKind::Draft => {
            let d = s.svc.set_popped_out(&id, true)?;
            (window_label("compose", &id), format!("index.html#/compose/{}", urlencode(&id)), if d.subject.is_empty() { "New message".to_string() } else { d.subject })
        }
        PopKind::Message => {
            let m = s.svc.get_message(&id)?;
            (window_label("message", &id), format!("index.html#/message/{}", urlencode(&id)), m.summary.subject)
        }
    };
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(route.into()))
        .title(title)
        .inner_size(960.0, 720.0)
        .min_inner_size(560.0, 420.0)
        .build()
        .map_err(|e| Error::Other(e.to_string()))?;
    let _ = w.set_focus();
    Ok(())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Close the pop-out and show the draft inline again.
#[tauri::command]
pub async fn dock_back(app: AppHandle, s: State<'_, AppState>, draft_id: String) -> R<()> {
    s.svc.set_popped_out(&draft_id, false)?;
    close_popout(&app, &draft_id);
    let _ = app.emit("draft://docked", json!({ "draftId": draft_id }));
    if let Some(w) = app.get_window(MAIN) {
        let _ = w.set_focus();
    }
    Ok(())
}

fn close_popout(app: &AppHandle, draft_id: &str) {
    if let Some(w) = app.get_webview_window(&window_label("compose", draft_id)) {
        let _ = w.close();
    }
}

/// A pop-out compose window was closed with the window's close button: dock the draft back.
pub fn on_window_closed(app: &AppHandle, label: &str) {
    if !label.starts_with("compose-") {
        return;
    }
    let Some(s) = app.try_state::<AppState>() else { return };
    let drafts: Vec<Draft> = s.svc.graph_accounts().unwrap_or_default().iter().flat_map(|a| s.svc.with_account(&a.id, |db| db.list_drafts()).unwrap_or_default()).collect();
    for d in drafts.into_iter().filter(|d| d.popped_out && window_label("compose", &d.id) == label) {
        let _ = s.svc.set_popped_out(&d.id, false);
        let _ = app.emit("draft://docked", json!({ "draftId": d.id }));
    }
}

/// Links from messages, the admin consent page and Teams links open in the system browser.
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> R<()> {
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") || lower.starts_with("msteams:") || lower.starts_with("tel:")) {
        return Err(Error::Invalid("Only web, mail and Teams links can be opened".into()));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| Error::Other(e.to_string()))
}
