//! Sync for Graph accounts: replay queued local changes, then folder list, message
//! delta per folder (within the offline window) and calendar view for a rolling window.
//! Sends go through the outbox rules: a send whose result is unknown is held, never repeated.

use crate::db::now_iso;
use crate::error::{Error, Result};
use crate::graph::{self, quote, GraphClient, HEADER_SELECT, MESSAGE_SELECT};
use crate::ids;
use crate::model::*;
use crate::ops::Op;
use crate::service::MailService;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

/// Calendar window: 3 months back, 12 months forward.
pub const CAL_BACK_DAYS: i64 = 92;
pub const CAL_FORWARD_DAYS: i64 = 366;
/// Bumped to force one full calendar re-read after a change in how delta items are stored.
const CAL_DELTA_VERSION: &str = "2";
/// Same for messages: bumped to re-read every folder's window once.
const MAIL_DELTA_VERSION: &str = "2";
/// Graph accepts simple attachments up to 3 MB; larger ones use an upload session.
const SMALL_ATTACHMENT: u64 = 3 * 1024 * 1024;
const CHUNK: usize = 5 * 320 * 1024;
/// Background attachment caching per run: (attachment lists fetched, bytes downloaded).
/// Older backlog catches up over later cycles, so syncing new mail is never held up for long.
const ATTACHMENT_BUDGET_FULL: (i64, i64) = (50, 200 * 1024 * 1024);
const ATTACHMENT_BUDGET_INBOX: (i64, i64) = (10, 25 * 1024 * 1024);

#[derive(Debug, Default, Clone)]
pub struct SyncReport {
    pub ops_done: usize,
    pub ops_failed: usize,
    pub messages_changed: usize,
    pub new_mail: Vec<MessageSummary>,
    pub events_changed: usize,
    pub offline: bool,
}

pub struct Syncer<'a> {
    pub svc: &'a MailService,
    pub graph: &'a GraphClient,
    pub account: Account,
}

impl<'a> Syncer<'a> {
    pub fn new(svc: &'a MailService, graph: &'a GraphClient, account: Account) -> Self {
        Syncer { svc, graph, account }
    }

    fn acc(&self) -> &str {
        &self.account.id
    }

    fn db<T>(&self, f: impl FnOnce(&crate::db::account::AccountDb) -> Result<T>) -> Result<T> {
        self.svc.with_account(&self.account.id, f)
    }

    /// One full cycle. Errors that mean "offline" are reported, not raised.
    pub async fn run(&self) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        self.svc.app().set_sync_state(self.acc(), SyncState::Syncing, None)?;
        self.svc.events().accounts_changed();
        let result = self.run_inner(&mut report).await;
        let (state, err) = match &result {
            Ok(()) => (SyncState::Idle, None),
            Err(e) if e.is_network() => {
                report.offline = true;
                (SyncState::Offline, None)
            }
            Err(Error::Auth(m)) => (SyncState::NeedsAuth, Some(m.clone())),
            Err(e) => (SyncState::Error, Some(e.to_string())),
        };
        self.svc.app().set_sync_state(self.acc(), state, err.as_deref())?;
        self.svc.set_online(!report.offline);
        self.svc.events().accounts_changed();
        self.svc.events().sync_status();
        if report.messages_changed > 0 || report.events_changed > 0 || report.ops_done > 0 {
            self.svc.events().mail_changed(std::slice::from_ref(&self.account.id));
        }
        if !report.new_mail.is_empty() && self.account.notifications {
            self.svc.events().new_mail(&self.account, &report.new_mail);
        }
        match result {
            Ok(()) => Ok(report),
            Err(e) if e.is_network() => Ok(report),
            Err(e) => Err(e),
        }
    }

    /// Inbox delta only, run between full cycles so new mail shows within seconds. Waits until
    /// the first full sync (and any one-time re-read) is done; network errors are left for
    /// the next full cycle to report.
    pub async fn run_inbox(&self) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        let ready = self.db(|db| Ok(db.kv_get("initialSyncDone")?.is_some() && db.kv_get("mailDeltaVersion")?.as_deref() == Some(MAIL_DELTA_VERSION)))?;
        let inbox = self.db(|db| db.folder_ids())?.into_iter().find(|(_, role)| *role == Some(FolderRole::Inbox));
        let Some((folder, role)) = inbox.filter(|_| ready) else { return Ok(report) };
        match self.sync_folder(&folder, role, false, &mut report).await {
            Ok(()) => {}
            Err(e) if e.is_network() => {
                report.offline = true;
                return Ok(report);
            }
            Err(e) => return Err(e),
        }
        match self.sync_attachments(ATTACHMENT_BUDGET_INBOX, &mut report).await {
            Ok(()) => {}
            Err(e) if e.is_network() => {
                report.offline = true;
                return Ok(report);
            }
            Err(e) => return Err(e),
        }
        // Keep "last synced" current, without overwriting an offline or error state.
        if self.account.sync_state == SyncState::Idle {
            self.svc.app().set_sync_state(self.acc(), SyncState::Idle, None)?;
            self.svc.events().sync_status();
        }
        if report.messages_changed > 0 {
            self.svc.events().mail_changed(std::slice::from_ref(&self.account.id));
        }
        if !report.new_mail.is_empty() && self.account.notifications {
            self.svc.events().new_mail(&self.account, &report.new_mail);
        }
        Ok(report)
    }

    /// Just the queued changes, straight away: what the outbox loop runs when something is
    /// sent or changed, so it doesn't wait for a full sync. After a send, Sent is refreshed so
    /// the sent copy shows. Offline is reported, not raised.
    pub async fn run_outbox(&self) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        if self.db(|db| db.due_ops(&now_iso()))?.is_empty() {
            return Ok(report);
        }
        let sends_before = self.db(|db| Ok(db.due_ops(&now_iso())?.iter().filter(|o| o.kind == "send").count()))?;
        self.replay_ops(&mut report).await?;
        if report.offline {
            self.svc.set_online(false);
            self.svc.events().sync_status();
            return Ok(report);
        }
        self.svc.set_online(true);
        if sends_before > 0 && report.ops_done > 0 {
            let ready = self.db(|db| db.kv_get("initialSyncDone"))?.is_some();
            let sent = self.db(|db| db.folder_ids())?.into_iter().find(|(_, role)| *role == Some(FolderRole::Sent));
            if let (true, Some((folder, role))) = (ready, sent) {
                match self.sync_folder(&folder, role, false, &mut report).await {
                    Err(e) if !e.is_network() => tracing::warn!("refreshing Sent: {e}"),
                    _ => {}
                }
            }
        }
        if report.ops_done > 0 || report.messages_changed > 0 {
            self.svc.events().mail_changed(std::slice::from_ref(&self.account.id));
        }
        self.svc.events().sync_status();
        Ok(report)
    }

    async fn run_inner(&self, report: &mut SyncReport) -> Result<()> {
        self.replay_ops(report).await?;
        if report.offline {
            return Err(Error::Network("offline".into()));
        }
        self.reconcile_held_sends().await?;
        self.sync_me().await?;
        self.sync_folders().await?;
        self.sync_messages(report).await?;
        if self.db(|db| db.drop_orphaned_adopted_drafts())? > 0 {
            report.messages_changed += 1;
        }
        self.sync_attachments(ATTACHMENT_BUDGET_FULL, report).await?;
        self.sync_calendars(report).await?;
        self.prune_bodies()?;
        self.prune_attachments()?;
        Ok(())
    }

    async fn sync_me(&self) -> Result<()> {
        if self.svc.app().kv_get("me")?.is_some() {
            return Ok(());
        }
        let me = self.graph.get("/me?$select=displayName,mail,userPrincipalName").await?;
        let email = me.get("mail").and_then(|v| v.as_str()).or_else(|| me.get("userPrincipalName").and_then(|v| v.as_str())).unwrap_or(&self.account.email);
        self.svc.set_me(&Me { name: me.get("displayName").and_then(|v| v.as_str()).unwrap_or("").to_string(), email: email.to_string() })
    }

    // ------------------------------------------------------------ folders

    pub async fn sync_folders(&self) -> Result<()> {
        let mut roles = vec![];
        for role in FolderRole::ALL {
            match self.graph.get(&format!("/me/mailFolders/{}?$select=id", role.graph_name())).await {
                Ok(v) => roles.push((role, v["id"].as_str().unwrap_or("").to_string())),
                Err(Error::Graph { status: 404, .. }) => {}
                Err(e) => return Err(e),
            }
        }
        let mut all = vec![];
        let mut queue: Vec<(String, Option<String>)> = vec![("/me/mailFolders?$top=100&$select=id,displayName,parentFolderId,totalItemCount,childFolderCount".into(), None)];
        while let Some((url, parent)) = queue.pop() {
            let mut next = Some(url);
            while let Some(u) = next.take() {
                let page = self.graph.get(&u).await?;
                for f in page["value"].as_array().cloned().unwrap_or_default() {
                    let id = f["id"].as_str().unwrap_or("").to_string();
                    if f["childFolderCount"].as_i64().unwrap_or(0) > 0 {
                        queue.push((format!("/me/mailFolders/{}/childFolders?$top=100&$select=id,displayName,parentFolderId,totalItemCount,childFolderCount", quote(&id)), Some(id.clone())));
                    }
                    all.push((f, parent.clone()));
                }
                next = page["@odata.nextLink"].as_str().map(String::from);
            }
        }
        // Skip system folders the interface never shows.
        let hidden = ["Conversation History", "Sync Issues", "RSS Feeds", "Outbox", "Clutter"];
        self.db(|db| {
            let mut keep = vec![];
            for (f, parent) in &all {
                let id = f["id"].as_str().unwrap_or("");
                let name = f["displayName"].as_str().unwrap_or("");
                let role = roles.iter().find(|(_, rid)| rid == id).map(|(r, _)| *r);
                if role.is_none() && parent.is_none() && hidden.contains(&name) {
                    continue;
                }
                db.upsert_folder(id, name, role, parent.as_deref(), f["totalItemCount"].as_i64().unwrap_or(0))?;
                keep.push(id.to_string());
            }
            db.retain_folders(&keep)
        })
    }

    // ------------------------------------------------------------ messages

    fn window_start(&self) -> String {
        (Utc::now() - Duration::days(self.account.offline_months.max(1) * 31)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    pub async fn sync_messages(&self, report: &mut SyncReport) -> Result<()> {
        // Rows written before partial delta items were merged may be blank: drop the saved
        // delta links once so this round re-reads every folder's window in full.
        if self.db(|db| db.kv_get("mailDeltaVersion"))?.as_deref() != Some(MAIL_DELTA_VERSION) {
            self.db(|db| {
                for (f, _) in db.folder_ids()? {
                    db.set_folder_delta(&f, None)?;
                }
                db.kv_set("mailDeltaVersion", MAIL_DELTA_VERSION)
            })?;
        }
        let folders = self.db(|db| db.folder_ids())?;
        let first_sync = self.db(|db| db.kv_get("initialSyncDone"))?.is_none();
        for (folder, role) in folders {
            if role == Some(FolderRole::Junk) && first_sync {
                // Junk syncs after the first run so the inbox is ready sooner.
                continue;
            }
            self.sync_folder(&folder, role, first_sync, report).await?;
        }
        self.db(|db| db.kv_set("initialSyncDone", &now_iso()))?;
        Ok(())
    }

    async fn sync_folder(&self, folder: &str, role: Option<FolderRole>, first_sync: bool, report: &mut SyncReport) -> Result<()> {
        let start = self.window_start();
        let mut url = match self.db(|db| db.folder_delta(folder))? {
            Some(link) => link,
            None => format!(
                "/me/mailFolders/{}/messages/delta?$select={}&$filter=receivedDateTime+ge+{}",
                quote(folder),
                MESSAGE_SELECT,
                start
            ),
        };
        let mut restarted = false;
        loop {
            let page = match self.graph.get_paged(&url, &["odata.maxpagesize=50"]).await {
                Ok(p) => p,
                // Delta token expired: start this folder again.
                Err(Error::Graph { status: 410, .. }) | Err(Error::Graph { code: _, status: 400, .. }) if !restarted => {
                    restarted = true;
                    self.db(|db| db.set_folder_delta(folder, None))?;
                    url = format!("/me/mailFolders/{}/messages/delta?$select={}&$filter=receivedDateTime+ge+{}", quote(folder), MESSAGE_SELECT, start);
                    continue;
                }
                Err(e) => return Err(e),
            };
            let items = page["value"].as_array().cloned().unwrap_or_default();
            let mut records = vec![];
            for v in &items {
                let id = v["id"].as_str().unwrap_or("").to_string();
                if v.get("@removed").is_some() {
                    // Only delete if it is still recorded in this folder (it may have moved).
                    self.db(|db| {
                        if let Ok(m) = db.get_message(&id) {
                            if m.raw_folder_id == folder {
                                db.delete_message(&id)?;
                            }
                        }
                        Ok(())
                    })?;
                    report.messages_changed += 1;
                    continue;
                }
                let Some(mut rec) = self.delta_message(v).await? else { continue };
                if rec.folder_id.is_empty() {
                    rec.folder_id = folder.to_string();
                }
                let is_new = !self.db(|db| db.message_exists(&rec.id))?;
                if is_new && !first_sync && role == Some(FolderRole::Inbox) && !rec.is_read && rec.received_at >= start {
                    report.new_mail.push(MessageSummary {
                        id: ids::join(self.acc(), &rec.id),
                        account_id: self.acc().to_string(),
                        folder_id: ids::join(self.acc(), &rec.folder_id),
                        conversation_id: rec.conversation_id.clone(),
                        from: rec.from.clone(),
                        to: rec.to.clone(),
                        subject: rec.subject.clone(),
                        snippet: rec.snippet.clone(),
                        received_at: rec.received_at.clone(),
                        is_read: rec.is_read,
                        is_flagged: rec.is_flagged,
                        has_attachments: rec.has_attachments,
                        is_draft: rec.is_draft,
                        has_draft: false,
                    });
                }
                records.push(rec);
            }
            report.messages_changed += records.len();
            self.svc.store_messages(self.acc(), &records)?;
            if let Some(next) = page["@odata.nextLink"].as_str() {
                url = next.to_string();
                continue;
            }
            if let Some(delta) = page["@odata.deltaLink"].as_str() {
                self.db(|db| db.set_folder_delta(folder, Some(delta)))?;
            }
            break;
        }
        Ok(())
    }

    /// A message delta item as a full record. Graph may send only the id and the changed
    /// properties: merge those onto the stored row, or fetch the message when there is no
    /// complete row to merge onto (new mail can arrive like this). None if it is gone.
    async fn delta_message(&self, v: &Value) -> Result<Option<crate::db::account::MessageRecord>> {
        if graph::is_full_message(v) {
            return Ok(Some(graph::message_record(v, true)));
        }
        let id = v["id"].as_str().unwrap_or("").to_string();
        let stored = self.db(|db| db.get_message_record(&id))?.filter(|r| !r.received_at.is_empty());
        if let Some(base) = stored {
            return Ok(Some(graph::message_record_over(v, true, &base)));
        }
        match self.graph.get(&format!("/me/messages/{}?$select={}", quote(&id), MESSAGE_SELECT)).await {
            Ok(full) => Ok(Some(graph::message_record(&full, true))),
            Err(Error::Graph { status: 404, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Keep headers but drop bodies that have slid out of the offline window.
    fn prune_bodies(&self) -> Result<()> {
        let start = self.window_start();
        self.db(|db| {
            db.conn.execute("UPDATE messages SET body_html = NULL WHERE received_at < ?1 AND body_html IS NOT NULL", [start])?;
            Ok(())
        })
    }

    /// Delete cached attachment files that no longer belong to mail inside the offline window
    /// (it slid out, or the message was deleted). Old attachments still open on demand: they're
    /// downloaded again. Files touched in the last hour are left for a later cycle, so one just
    /// opened from an old message isn't pulled from under the app showing it, and a file that
    /// can't be removed (open elsewhere on Windows) is simply tried again next time.
    fn prune_attachments(&self) -> Result<()> {
        let start = self.window_start();
        let keep: HashSet<String> = self.db(|db| db.cached_attachment_paths_since(&start))?.into_iter().collect();
        let root = self.svc.paths.attachments_dir(self.acc());
        let Ok(dirs) = std::fs::read_dir(&root) else { return Ok(()) };
        let recent = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        let mut removed = vec![];
        for dir in dirs.flatten().map(|d| d.path()).filter(|p| p.is_dir()) {
            for file in std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|f| f.path()) {
                let p = file.to_string_lossy().to_string();
                let touched = std::fs::metadata(&file).and_then(|m| m.modified()).map(|t| t > recent).unwrap_or(true);
                if keep.contains(&p) || touched {
                    continue;
                }
                match std::fs::remove_file(&file) {
                    Ok(()) => removed.push(p),
                    Err(e) => tracing::debug!("keeping {p} for now: {e}"),
                }
            }
            let _ = std::fs::remove_dir(&dir); // only succeeds once empty
        }
        if !removed.is_empty() {
            self.db(|db| db.clear_attachment_paths(&removed))?;
        }
        Ok(())
    }

    /// Fetch the body of a header-only message (opened from outside the offline window).
    pub async fn fetch_message(&self, raw_id: &str) -> Result<()> {
        let v = self.graph.get(&format!("/me/messages/{}?$select={}", quote(raw_id), MESSAGE_SELECT)).await?;
        let rec = graph::message_record(&v, true);
        self.svc.store_messages(self.acc(), &[rec])
    }

    /// Meeting requests, cancellations and responses: read the event the message is about,
    /// once, so the reading pane can show when it is. The event also goes into the local
    /// calendar if calendar sync hasn't brought it in (it can be beyond the synced range), so
    /// the invitation can be answered from the message. True when something was stored.
    pub async fn ensure_meeting(&self, raw_id: &str) -> Result<bool> {
        let (known, stored) = self.db(|db| db.meeting_state(raw_id))?;
        if stored {
            return Ok(false);
        }
        let kind = match known {
            Some(t) => t,
            None => {
                // Synced before meeting messages were recognised, or the delta item didn't say.
                let v = self.graph.get(&format!("/me/messages/{}?$select=id", quote(raw_id))).await?;
                let t = graph::meeting_type(&v).unwrap_or_default();
                self.db(|db| db.set_meeting_type(raw_id, &t))?;
                t
            }
        };
        if kind.is_empty() {
            return Ok(false);
        }
        let v = self
            .graph
            .get(&format!("/me/messages/{}?$expand=microsoft.graph.eventMessage/event($select={})", quote(raw_id), graph::EVENT_SELECT))
            .await?;
        let info = graph::meeting_info(&v);
        let event = v.get("event").filter(|e| e.is_object());
        self.db(|db| {
            if let (Some(ev), Some(id)) = (event, &info.event_id) {
                if !db.has_event(id)? {
                    if let Some(cal) = db.default_calendar()? {
                        db.upsert_event(&graph::event_record(ev, &cal))?;
                    }
                }
            }
            db.set_meeting(raw_id, &info)
        })?;
        Ok(true)
    }

    /// Attachment metadata, and inline images small enough to show in the body.
    pub async fn ensure_attachments(&self, raw_id: &str) -> Result<bool> {
        let m = self.db(|db| db.get_message(raw_id))?;
        let needs = m.message.summary.has_attachments || m.message.body_html.contains("cid:");
        if !needs {
            return Ok(false);
        }
        if self.db(|db| Ok(db.attachments_checked(raw_id)? || db.has_attachment_rows(raw_id)?))? {
            // Known list: bring back inline images pruned from the cache when the message
            // left the offline window, so the body shows them again.
            let missing: Vec<String> = self
                .db(|db| db.list_attachments(raw_id))?
                .into_iter()
                .filter(|a| a.content_id.is_some() && a.size <= 2_000_000)
                .filter(|a| !a.local_path.as_deref().is_some_and(|p| std::path::Path::new(p).exists()))
                .map(|a| a.id)
                .collect();
            for id in &missing {
                self.download_attachment(raw_id, id).await?;
            }
            return Ok(!missing.is_empty());
        }
        let v = self
            .graph
            .get(&format!("/me/messages/{}/attachments?$select=id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId", quote(raw_id)))
            .await?;
        let list: Vec<Attachment> = v["value"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|a| Attachment {
                id: a["id"].as_str().unwrap_or("").into(),
                name: a["name"].as_str().unwrap_or("attachment").into(),
                content_type: a["contentType"].as_str().unwrap_or("application/octet-stream").into(),
                size: a["size"].as_i64().unwrap_or(0),
                is_inline: a["isInline"].as_bool().unwrap_or(false),
                content_id: a["contentId"].as_str().map(String::from),
                local_path: None,
            })
            .collect();
        self.db(|db| {
            db.replace_attachments(raw_id, &list)?;
            db.set_attachments_checked(raw_id)
        })?;
        for a in list.iter().filter(|a| a.content_id.is_some() && a.size <= 2_000_000) {
            self.download_attachment(raw_id, &a.id).await?;
        }
        Ok(!list.is_empty())
    }

    /// Cache attachments of mail inside the offline window so they open without a connection.
    /// Network and sign-in errors stop the step (the cycle reports them); a refusal for one
    /// item is recorded so it isn't retried every cycle, and anything else is retried next time.
    pub async fn sync_attachments(&self, (max_lists, max_bytes): (i64, i64), report: &mut SyncReport) -> Result<()> {
        let start = self.window_start();
        let fatal = |e: &Error| e.is_network() || matches!(e, Error::Auth(_));
        let refused = |e: &Error| matches!(e.status(), Some(s) if (400..500).contains(&s) && s != 429);

        for raw_id in self.db(|db| db.messages_needing_attachment_list(&start, max_lists))? {
            match self.ensure_attachments(&raw_id).await {
                Ok(true) => report.messages_changed += 1,
                Ok(false) => {}
                Err(e) if fatal(&e) => return Err(e),
                Err(e) if refused(&e) => {
                    tracing::warn!("attachment list for {raw_id}: {e}");
                    self.db(|db| db.set_attachments_checked(&raw_id))?;
                }
                Err(e) => tracing::warn!("attachment list for {raw_id}: {e}"),
            }
        }

        let mut spent = 0i64;
        for (raw_id, att_id, size) in self.db(|db| db.attachments_to_download(&start, 500))? {
            // Always take at least one, so a file bigger than the budget still arrives.
            if spent > 0 && spent + size > max_bytes {
                break;
            }
            match self.download_attachment(&raw_id, &att_id).await {
                Ok(_) => spent += size.max(1),
                Err(e) if fatal(&e) => return Err(e),
                Err(e) if refused(&e) => {
                    tracing::warn!("attachment {att_id} of {raw_id}: {e}");
                    self.db(|db| db.set_attachment_failed(&raw_id, &att_id))?;
                }
                Err(e) => tracing::warn!("attachment {att_id} of {raw_id}: {e}"),
            }
        }
        Ok(())
    }

    /// Download to the account's cache, return the local path.
    pub async fn download_attachment(&self, raw_id: &str, attachment_id: &str) -> Result<String> {
        let att = self
            .db(|db| db.list_attachments(raw_id))?
            .into_iter()
            .find(|a| a.id == attachment_id)
            .ok_or_else(|| Error::NotFound("attachment".into()))?;
        if let Some(p) = &att.local_path {
            if std::path::Path::new(p).exists() {
                return Ok(p.clone());
            }
        }
        let bytes = self.graph.get_bytes(&format!("/me/messages/{}/attachments/{}/$value", quote(raw_id), quote(attachment_id))).await?;
        let dir = self.svc.paths.attachments_dir(self.acc()).join(short_hash(raw_id));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(safe_file_name(&att.name));
        std::fs::write(&path, bytes)?;
        let p = path.to_string_lossy().to_string();
        self.db(|db| db.set_attachment_path(raw_id, attachment_id, &p))?;
        Ok(p)
    }

    /// Server search beyond the offline window. Results are stored as headers.
    pub async fn search_server(&self, q: &SearchQuery) -> Result<Vec<String>> {
        let mut kql = vec![];
        let text = q.text.replace('"', "");
        let text = text.trim();
        if !text.is_empty() {
            kql.push(match q.field {
                SearchField::All | SearchField::Content => text.to_string(),
                SearchField::From => format!("from:{text}"),
                SearchField::To => format!("to:{text}"),
                SearchField::Subject => format!("subject:{text}"),
            });
        }
        if let Some(f) = &q.from {
            kql.push(format!("from:{f}"));
        }
        if let Some(t) = &q.to {
            kql.push(format!("to:{t}"));
        }
        if q.has_attachment == Some(true) {
            kql.push("hasattachments:true".into());
        }
        if kql.is_empty() {
            return Ok(vec![]);
        }
        let v = self.graph.get(&format!("/me/messages?$search=\"{}\"&$top=50&$select={}", quote(&kql.join(" ")), HEADER_SELECT)).await?;
        let known: HashSet<String> = self.db(|db| db.folder_ids())?.into_iter().map(|(id, _)| id).collect();
        let mut out = vec![];
        let mut records = vec![];
        for item in v["value"].as_array().cloned().unwrap_or_default() {
            let rec = graph::message_record(&item, false);
            if known.contains(&rec.folder_id) {
                out.push(ids::join(self.acc(), &rec.id));
                records.push(rec);
            }
        }
        self.svc.store_messages(self.acc(), &records)?;
        Ok(out)
    }

    // ------------------------------------------------------------ calendar

    pub async fn sync_calendars(&self, report: &mut SyncReport) -> Result<()> {
        let v = self.graph.get("/me/calendars?$select=id,name,isDefaultCalendar,canEdit").await?;
        let cals = v["value"].as_array().cloned().unwrap_or_default();
        self.db(|db| {
            for c in &cals {
                db.upsert_calendar(c["id"].as_str().unwrap_or(""), c["name"].as_str().unwrap_or("Calendar"), c["isDefaultCalendar"].as_bool().unwrap_or(false), c["canEdit"].as_bool().unwrap_or(true))?;
            }
            Ok(())
        })?;
        let now = Utc::now();
        let start = (now - Duration::days(CAL_BACK_DAYS)).format("%Y-%m-%dT00:00:00Z").to_string();
        let end = (now + Duration::days(CAL_FORWARD_DAYS)).format("%Y-%m-%dT00:00:00Z").to_string();
        for c in &cals {
            let id = c["id"].as_str().unwrap_or("").to_string();
            if c["isDefaultCalendar"].as_bool().unwrap_or(false) {
                self.sync_default_calendar(&id, &start, &end, report).await?;
            } else {
                self.sync_other_calendar(&id, &start, &end, report).await?;
            }
        }
        Ok(())
    }

    /// calendarView/delta for the default calendar; restarted when the window moves on a day.
    async fn sync_default_calendar(&self, cal: &str, start: &str, end: &str, report: &mut SyncReport) -> Result<()> {
        let window = format!("{start}|{end}");
        // Rows written before partial delta items were merged may have lost their titles:
        // drop the saved delta link once so the next round re-reads the whole window.
        if self.db(|db| db.kv_get("calDeltaVersion"))?.as_deref() != Some(CAL_DELTA_VERSION) {
            self.db(|db| {
                db.kv_set("calWindow", "")?;
                db.kv_set("calDeltaVersion", CAL_DELTA_VERSION)
            })?;
        }
        let saved_window = self.db(|db| db.kv_get("calWindow"))?;
        let mut masters = std::collections::HashMap::new();
        let mut url = match (self.db(|db| db.kv_get("calDelta"))?, saved_window.as_deref() == Some(window.as_str())) {
            (Some(link), true) => link,
            _ => format!("/me/calendarView/delta?startDateTime={start}&endDateTime={end}"),
        };
        let full = !url.contains("deltatoken");
        let mut seen = vec![];
        let mut restarted = false;
        loop {
            let page = match self.graph.get_paged(&url, &["odata.maxpagesize=100"]).await {
                Ok(p) => p,
                Err(Error::Graph { status: 410, .. }) if !restarted => {
                    restarted = true;
                    url = format!("/me/calendarView/delta?startDateTime={start}&endDateTime={end}");
                    continue;
                }
                Err(e) => return Err(e),
            };
            for item in page["value"].as_array().cloned().unwrap_or_default() {
                let id = item["id"].as_str().unwrap_or("").to_string();
                if item.get("@removed").is_some() {
                    self.db(|db| db.delete_event(&id))?;
                } else {
                    let rec = self.merged_event(&item, cal, &mut masters).await?;
                    self.db(|db| db.upsert_event(&rec))?;
                    seen.push(id);
                }
                report.events_changed += 1;
            }
            if let Some(n) = page["@odata.nextLink"].as_str() {
                url = n.to_string();
                continue;
            }
            if let Some(d) = page["@odata.deltaLink"].as_str() {
                self.db(|db| {
                    db.kv_set("calDelta", d)?;
                    db.kv_set("calWindow", &window)
                })?;
            }
            break;
        }
        if full {
            self.db(|db| db.retain_events_in_range(cal, start, end, &seen))?;
        }
        Ok(())
    }

    /// A delta item merged onto what is stored for it. An occurrence that arrives with no
    /// details and has nothing stored takes them from its series master.
    async fn merged_event(&self, item: &Value, cal: &str, masters: &mut std::collections::HashMap<String, Option<Value>>) -> Result<crate::db::account::EventRecord> {
        let id = item["id"].as_str().unwrap_or("").to_string();
        if item["type"].as_str() == Some("seriesMaster") {
            masters.insert(id.clone(), Some(item.clone()));
        }
        let stored = self.db(|db| db.get_event_record(&id))?.filter(|r| !r.subject.is_empty());
        if stored.is_some() || !graph::is_bare_occurrence(item) {
            return Ok(graph::event_record_over(item, cal, stored.as_ref()));
        }
        let master_id = item["seriesMasterId"].as_str().unwrap_or("").to_string();
        if !masters.contains_key(&master_id) {
            let fetched = self
                .graph
                .get(&format!(
                    "/me/events/{}?$select=subject,isAllDay,location,body,organizer,attendees,responseStatus,isOnlineMeeting,onlineMeeting,isReminderOn,reminderMinutesBeforeStart,isCancelled",
                    quote(&master_id)
                ))
                .await;
            let master = match fetched {
                Ok(v) => Some(v),
                Err(e) if e.is_network() => return Err(e),
                Err(_) => None,
            };
            masters.insert(master_id.clone(), master);
        }
        let base = masters.get(&master_id).cloned().flatten().map(|m| graph::event_record(&m, cal));
        Ok(graph::event_record_over(item, cal, base.as_ref()))
    }

    async fn sync_other_calendar(&self, cal: &str, start: &str, end: &str, report: &mut SyncReport) -> Result<()> {
        let mut url = Some(format!("/me/calendars/{}/calendarView?startDateTime={start}&endDateTime={end}&$top=200", quote(cal)));
        let mut seen = vec![];
        while let Some(u) = url.take() {
            let page = self.graph.get(&u).await?;
            for item in page["value"].as_array().cloned().unwrap_or_default() {
                let rec = graph::event_record(&item, cal);
                seen.push(rec.id.clone());
                self.db(|db| db.upsert_event(&rec))?;
                report.events_changed += 1;
            }
            url = page["@odata.nextLink"].as_str().map(String::from);
        }
        self.db(|db| db.retain_events_in_range(cal, start, end, &seen))
    }

    // ------------------------------------------------------------ pending operations

    pub async fn replay_ops(&self, report: &mut SyncReport) -> Result<()> {
        let _one_at_a_time = self.svc.replay_lock.lock().await;
        let ops = self.db(|db| db.due_ops(&now_iso()))?;
        for op in ops {
            let parsed: Op = match serde_json::from_value(op.payload.clone()) {
                Ok(o) => o,
                Err(_) => {
                    self.db(|db| db.op_done(op.id))?;
                    continue;
                }
            };
            match self.apply(&parsed, op.id).await {
                Ok(()) => {
                    report.ops_done += 1;
                    // Held sends stay queued (for the user); everything else is finished.
                    self.db(|db| {
                        if db.all_ops()?.iter().any(|o| o.id == op.id && o.state == "pending") {
                            db.op_done(op.id)?;
                        }
                        Ok(())
                    })?;
                }
                Err(e) if e.is_network() => {
                    report.offline = true;
                    let wait = 30 * (op.attempts + 1).pow(2);
                    let next = (Utc::now() + Duration::seconds(wait.min(3600))).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                    self.db(|db| db.op_retry_later(op.id, &next, &e.to_string()))?;
                    // Offline: stop here and keep the order.
                    return Ok(());
                }
                Err(Error::Auth(m)) => return Err(Error::Auth(m)),
                Err(e) => {
                    report.ops_failed += 1;
                    tracing::warn!("dropping {} after error: {e}", op.kind);
                    self.db(|db| db.op_done(op.id))?;
                }
            }
        }
        Ok(())
    }

    async fn apply(&self, op: &Op, op_id: i64) -> Result<()> {
        match op {
            Op::MarkRead { ids, read } => {
                for id in ids {
                    ignore_404(self.graph.patch(&format!("/me/messages/{}", quote(id)), &json!({"isRead": read})).await)?;
                }
            }
            Op::Flag { ids, flagged } => {
                for id in ids {
                    let status = if *flagged { "flagged" } else { "notFlagged" };
                    ignore_404(self.graph.patch(&format!("/me/messages/{}", quote(id)), &json!({"flag": {"flagStatus": status}})).await)?;
                }
            }
            Op::Move { ids, destination } => {
                for id in ids {
                    match self.graph.post(&format!("/me/messages/{}/move", quote(id)), &json!({"destinationId": destination})).await {
                        Ok(v) => {
                            let new_id = v["id"].as_str().unwrap_or(id).to_string();
                            let folder = v["parentFolderId"].as_str().unwrap_or("").to_string();
                            self.db(|db| {
                                if &new_id != id {
                                    db.rename_message(id, &new_id)?;
                                }
                                if !folder.is_empty() {
                                    db.move_message(&new_id, &folder)?;
                                }
                                Ok(())
                            })?;
                        }
                        Err(Error::Graph { status: 404, .. }) => {}
                        Err(e) => return Err(e),
                    }
                }
            }
            Op::DeleteMessages { ids } => {
                for id in ids {
                    ignore_404(self.graph.delete(&format!("/me/messages/{}", quote(id))).await.map(|_| Value::Null))?;
                }
            }
            Op::DeleteServerDraft { server_id } => {
                ignore_404(self.graph.delete(&format!("/me/messages/{}", quote(server_id))).await.map(|_| Value::Null))?;
            }
            Op::SaveDraft { draft_id } => {
                if self.db(|db| db.get_draft(draft_id)).is_ok() {
                    self.save_draft(draft_id).await?;
                }
            }
            Op::Send { draft_id } => self.send(draft_id, op_id).await?,
            Op::CreateEvent { event_id } => {
                let color = self.account.color.clone();
                let Ok(ev) = self.db(|db| db.get_event(event_id, &color)) else { return Ok(()) };
                let rec = self.event_rec(&ev)?;
                let v = self.graph.post(&format!("/me/calendars/{}/events", quote(&rec.calendar_id)), &graph::event_payload(&rec)).await?;
                let server = graph::event_record(&v, &rec.calendar_id);
                self.db(|db| {
                    db.delete_event(event_id)?;
                    db.upsert_event(&server)
                })?;
            }
            Op::UpdateEvent { event_id } => {
                let color = self.account.color.clone();
                let Ok(ev) = self.db(|db| db.get_event(event_id, &color)) else { return Ok(()) };
                let rec = self.event_rec(&ev)?;
                let v = ignore_404(self.graph.patch(&format!("/me/events/{}", quote(event_id)), &graph::event_payload(&rec)).await)?;
                if !v.is_null() {
                    let server = graph::event_record(&v, &rec.calendar_id);
                    self.db(|db| db.upsert_event(&server))?;
                }
            }
            Op::RespondEvent { event_id, response, send_response, comment } => {
                let mut body = json!({ "sendResponse": send_response });
                if let Some(c) = comment.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                    body["comment"] = json!(c);
                }
                ignore_404(self.graph.post(&format!("/me/events/{}/{}", quote(event_id), response.graph_action()), &body).await)?;
            }
            Op::DeleteEvent { event_id } => {
                ignore_404(self.graph.delete(&format!("/me/events/{}", quote(event_id))).await.map(|_| Value::Null))?;
            }
        }
        Ok(())
    }

    fn event_rec(&self, e: &CalendarEvent) -> Result<crate::db::account::EventRecord> {
        Ok(crate::db::account::EventRecord {
            id: ids::split(&e.id)?.1.to_string(),
            calendar_id: ids::split(&e.calendar_id)?.1.to_string(),
            subject: e.subject.clone(),
            start: e.start.clone(),
            end: e.end.clone(),
            is_all_day: e.is_all_day,
            location: e.location.clone(),
            body_html: e.body_html.clone(),
            organizer: e.organizer.clone(),
            attendees: e.attendees.clone(),
            my_response: e.my_response,
            is_online_meeting: e.is_online_meeting,
            online_meeting_url: e.online_meeting_url.clone(),
            reminder_minutes: e.reminder_minutes,
            is_cancelled: e.is_cancelled,
            local_only: false,
        })
    }

    /// Create or update the server copy of a draft. Returns the server id.
    pub async fn save_draft(&self, raw_id: &str) -> Result<String> {
        let (draft, server_id) = self.db(|db| db.get_draft(raw_id))?;
        let started = draft.updated_at.clone();
        let server_id = match server_id {
            Some(s) => s,
            None => {
                let source = draft.source_message_id.as_ref().and_then(|s| ids::split(s).ok().map(|(a, r)| (a.to_string(), r.to_string())));
                let created = match (draft.mode, source) {
                    (DraftMode::Reply | DraftMode::ReplyAll | DraftMode::Forward, Some((acc, src))) if acc == self.account.id => {
                        let action = match draft.mode {
                            DraftMode::Reply => "createReply",
                            DraftMode::ReplyAll => "createReplyAll",
                            _ => "createForward",
                        };
                        self.graph.post(&format!("/me/messages/{}/{action}", quote(&src)), &json!({})).await?
                    }
                    _ => self.graph.post("/me/messages", &json!({"subject": draft.subject, "body": {"contentType": "HTML", "content": draft.body_html}})).await?,
                };
                let sid = created["id"].as_str().ok_or_else(|| Error::Other("Graph returned no draft id".into()))?.to_string();
                self.db(|db| db.set_draft_server_id(raw_id, &sid))?;
                // Forwards carry the original attachments: show them so they can be removed.
                if draft.mode == DraftMode::Forward {
                    let v = self.graph.get(&format!("/me/messages/{}/attachments?$select=id,name,contentType,size,isInline", quote(&sid))).await?;
                    let mut d = self.db(|db| db.get_draft(raw_id))?.0;
                    for a in v["value"].as_array().cloned().unwrap_or_default() {
                        if !a["isInline"].as_bool().unwrap_or(false) {
                            d.attachments.push(Attachment {
                                id: a["id"].as_str().unwrap_or("").into(),
                                name: a["name"].as_str().unwrap_or("").into(),
                                content_type: a["contentType"].as_str().unwrap_or("").into(),
                                size: a["size"].as_i64().unwrap_or(0),
                                is_inline: false,
                                content_id: None,
                                local_path: None,
                            });
                        }
                    }
                    self.db(|db| db.save_draft(raw_id, &d, None, "user"))?;
                }
                sid
            }
        };
        let draft = self.db(|db| db.get_draft(raw_id))?.0;
        let quoted = self.db(|db| db.draft_quote(raw_id))?.unwrap_or_default();
        self.graph
            .patch(
                &format!("/me/messages/{}", quote(&server_id)),
                &json!({
                    "subject": draft.subject,
                    "body": {"contentType": "HTML", "content": format!("{}{}", draft.body_html, quoted)},
                    "toRecipients": graph::recipients(&draft.to),
                    "ccRecipients": graph::recipients(&draft.cc),
                    "bccRecipients": graph::recipients(&draft.bcc),
                }),
            )
            .await?;
        self.sync_draft_attachments(raw_id, &server_id).await?;
        // Only mark saved if nothing changed while we were saving.
        self.db(|db| {
            let (d, _) = db.get_draft(raw_id)?;
            if d.updated_at == started {
                db.set_draft_saved(raw_id, true)?;
            }
            Ok(())
        })?;
        self.svc.events().draft_changed(&ids::join(self.acc(), raw_id));
        Ok(server_id)
    }

    async fn sync_draft_attachments(&self, raw_id: &str, server_id: &str) -> Result<()> {
        let mut draft = self.db(|db| db.get_draft(raw_id))?.0;
        let v = self.graph.get(&format!("/me/messages/{}/attachments?$select=id,isInline", quote(server_id))).await?;
        let on_server: Vec<String> = v["value"].as_array().cloned().unwrap_or_default().iter().filter(|a| !a["isInline"].as_bool().unwrap_or(false)).filter_map(|a| a["id"].as_str().map(String::from)).collect();
        for sid in &on_server {
            if !draft.attachments.iter().any(|a| &a.id == sid) {
                ignore_404(self.graph.delete(&format!("/me/messages/{}/attachments/{}", quote(server_id), quote(sid))).await.map(|_| Value::Null))?;
            }
        }
        let mut changed = false;
        for a in draft.attachments.iter_mut() {
            if on_server.contains(&a.id) {
                continue;
            }
            let Some(path) = a.local_path.clone() else { continue };
            let bytes = std::fs::read(&path)?;
            let new_id = if (bytes.len() as u64) <= SMALL_ATTACHMENT {
                use base64::Engine;
                let v = self
                    .graph
                    .post(
                        &format!("/me/messages/{}/attachments", quote(server_id)),
                        &json!({"@odata.type": "#microsoft.graph.fileAttachment", "name": a.name, "contentType": a.content_type, "contentBytes": base64::engine::general_purpose::STANDARD.encode(&bytes)}),
                    )
                    .await?;
                v["id"].as_str().unwrap_or("").to_string()
            } else {
                let session = self
                    .graph
                    .post(
                        &format!("/me/messages/{}/attachments/createUploadSession", quote(server_id)),
                        &json!({"AttachmentItem": {"attachmentType": "file", "name": a.name, "size": bytes.len()}}),
                    )
                    .await?;
                let url = session["uploadUrl"].as_str().ok_or_else(|| Error::Other("no upload url".into()))?.to_string();
                let mut last = Value::Null;
                let mut from = 0;
                while from < bytes.len() {
                    let to = (from + CHUNK).min(bytes.len());
                    last = self.graph.put_chunk(&url, bytes[from..to].to_vec(), from, bytes.len()).await?;
                    from = to;
                }
                // The final response doesn't always carry the attachment id; re-list to find it.
                let _ = last;
                let v = self.graph.get(&format!("/me/messages/{}/attachments?$select=id,name", quote(server_id))).await?;
                v["value"].as_array().cloned().unwrap_or_default().iter().rev().find(|x| x["name"].as_str() == Some(a.name.as_str())).and_then(|x| x["id"].as_str().map(String::from)).unwrap_or_default()
            };
            if !new_id.is_empty() {
                a.id = new_id;
                changed = true;
            }
        }
        if changed {
            self.db(|db| {
                // Keep the user's latest edits; only swap attachment ids.
                let (mut current, _) = db.get_draft(raw_id)?;
                for c in current.attachments.iter_mut() {
                    if let Some(u) = draft.attachments.iter().find(|u| u.local_path.is_some() && u.local_path == c.local_path && u.name == c.name) {
                        c.id = u.id.clone();
                    }
                }
                db.save_draft(raw_id, &current, None, "user")
            })?;
        }
        Ok(())
    }

    /// Send a queued draft. A send whose result is unknown is held and flagged, never repeated.
    async fn send(&self, raw_id: &str, op_id: i64) -> Result<()> {
        let Ok((draft, server_id)) = self.db(|db| db.get_draft(raw_id)) else { return Ok(()) };
        if draft.status == DraftStatus::Sent {
            return Ok(());
        }
        // Make sure the server copy is current. A failure here is safe to retry: nothing was sent.
        if draft.status == DraftStatus::Sending {
            // A send cut off part way (the app quit): it may have gone. Held, never repeated;
            // reconcile_held_sends settles it from the server.
            self.hold(raw_id, op_id, "interrupted while sending")?;
            return Ok(());
        }
        if draft.status != DraftStatus::Queued {
            // Taken back to edit (or held for the user): not ours to send.
            return Ok(());
        }
        let server_id = match (server_id, draft.saved_to_server) {
            (Some(s), true) => s,
            _ => self.save_draft(raw_id).await?,
        };
        // Taken back to edit while we were saving: don't send.
        if !self.db(|db| db.claim_draft_for_send(raw_id))? {
            return Ok(());
        }
        self.svc.events().draft_changed(&ids::join(self.acc(), raw_id));
        match self.graph.post(&format!("/me/messages/{}/send", quote(&server_id)), &json!({})).await {
            Ok(_) => {
                self.finish_sent(raw_id, &server_id)?;
                Ok(())
            }
            Err(Error::Network(m)) => {
                // Never reached the server: queue again.
                self.db(|db| db.set_draft_status(raw_id, DraftStatus::Queued, None))?;
                Err(Error::Network(m))
            }
            Err(e @ (Error::NoResponse(_) | Error::Graph { status: 500..=599, .. })) => {
                self.hold(raw_id, op_id, &e.to_string())?;
                Ok(())
            }
            Err(Error::Auth(m)) => {
                self.db(|db| db.set_draft_status(raw_id, DraftStatus::Queued, None))?;
                Err(Error::Auth(m))
            }
            Err(e) => {
                self.db(|db| db.set_draft_status(raw_id, DraftStatus::Failed, Some(&friendly_send_error(&e))))?;
                self.svc.events().draft_changed(&ids::join(self.acc(), raw_id));
                // Back to a draft to finish, so its conversation's row shows it again.
                self.svc.events().mail_changed(&[self.acc().to_string()]);
                Err(e)
            }
        }
    }

    fn hold(&self, raw_id: &str, op_id: i64, why: &str) -> Result<()> {
        self.db(|db| {
            db.set_draft_status(raw_id, DraftStatus::Unknown, Some("We couldn't confirm this was sent. Check Sent before sending again."))?;
            db.op_set_state(op_id, "held", Some(why))
        })?;
        self.svc.events().draft_changed(&ids::join(self.acc(), raw_id));
        self.svc.events().sync_status();
        Ok(())
    }

    fn finish_sent(&self, raw_id: &str, server_id: &str) -> Result<()> {
        let attachments = self.db(|db| db.get_draft(raw_id)).map(|(d, _)| d.attachments).unwrap_or_default();
        self.db(|db| {
            db.delete_draft(raw_id)?;
            db.delete_drafts_for_server_id(server_id)?;
            db.delete_message(server_id)?;
            for op in db.ops_for_draft(raw_id)? {
                db.op_done(op.id)?;
            }
            Ok(())
        })?;
        // Sent: the server has its own copy now.
        self.svc.delete_dropped_copies(&attachments);
        self.svc.events().draft_changed(&ids::join(self.acc(), raw_id));
        self.svc.events().sync_status();
        // Out of the Outbox; lists and counts refresh.
        self.svc.events().mail_changed(&[self.acc().to_string()]);
        Ok(())
    }

    /// A held send whose server draft is gone was sent: resolve it. If the draft is still in
    /// Drafts, it stays held for the user to decide.
    pub async fn reconcile_held_sends(&self) -> Result<()> {
        let held: Vec<(String, Option<String>)> = self.db(|db| {
            let mut st = db.conn.prepare("SELECT id, server_id FROM drafts WHERE status = 'unknown'")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        for (raw, sid) in held {
            let Some(sid) = sid else { continue };
            match self.graph.get(&format!("/me/messages/{}?$select=id,isDraft", quote(&sid))).await {
                Err(Error::Graph { status: 404, .. }) => self.finish_sent(&raw, &sid)?,
                Ok(v) if v["isDraft"].as_bool() == Some(false) => self.finish_sent(&raw, &sid)?,
                Ok(_) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

fn ignore_404(r: Result<Value>) -> Result<Value> {
    match r {
        Err(Error::Graph { status: 404, .. }) => Ok(Value::Null),
        other => other,
    }
}

fn friendly_send_error(e: &Error) -> String {
    match e {
        Error::Graph { code, message, .. } if code.contains("Recipient") || message.to_lowercase().contains("recipient") => format!("A recipient address was rejected: {message}"),
        Error::Graph { message, .. } => format!("Couldn't send: {message}"),
        other => format!("Couldn't send: {other}"),
    }
}

fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(s.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "attachment".into()
    } else {
        trimmed.chars().take(150).collect()
    }
}

/// Count unread inbox messages (used for the tray badge).
pub fn total_unread(svc: &MailService) -> Result<i64> {
    Ok(svc.list_accounts()?.iter().filter_map(|a| a.unread).sum())
}

/// Merge server results into a local search.
pub fn merge_search(svc: &MailService, local: SearchResult, server_ids: &[String]) -> Result<SearchResult> {
    let mut msgs = local.messages;
    for id in server_ids {
        if msgs.iter().any(|m| &m.id == id) {
            continue;
        }
        if let Ok((acc, raw)) = ids::split(id) {
            if let Ok(m) = svc.with_account(acc, |db| db.get_message(raw)) {
                msgs.push(m.message.summary);
            }
        }
    }
    msgs.sort_by(|a, b| b.received_at.cmp(&a.received_at));
    let total = local.total.max(msgs.len() as i64);
    Ok(SearchResult { messages: msgs, total, contact: local.contact, from_server: true })
}

/// Factory for Graph clients, one per account.
pub type ClientFactory = Arc<dyn Fn(&Account) -> Result<GraphClient> + Send + Sync>;

/// Run sync for every Graph account, forever: the inbox every `inbox_every`, and a full
/// cycle every `full_every` or straight away when woken (focus, after an action).
/// Replay queued changes (sends above all) as soon as they're made, for every Graph account,
/// rather than waiting for the next full sync. Woken by `outbox`; also looks every 30 seconds
/// for retries that have come due.
pub async fn outbox_loop(svc: Arc<MailService>, clients: ClientFactory, outbox: Arc<tokio::sync::Notify>) {
    loop {
        tokio::select! {
            _ = outbox.notified() => {}
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
        }
        for a in svc.graph_accounts().unwrap_or_default() {
            if a.sync_state == SyncState::NeedsAuth {
                continue;
            }
            match clients(&a) {
                Ok(client) => match Syncer::new(&svc, &client, a.clone()).run_outbox().await {
                    Err(Error::Auth(m)) => {
                        let _ = svc.app().set_sync_state(&a.id, SyncState::NeedsAuth, Some(&m));
                        svc.events().accounts_changed();
                    }
                    Err(e) => tracing::warn!("outbox {}: {e}", a.email),
                    Ok(_) => {}
                },
                Err(e) => tracing::warn!("no client for {}: {e}", a.email),
            }
        }
    }
}

pub async fn run_loop(svc: Arc<MailService>, clients: ClientFactory, wake: Arc<tokio::sync::Notify>, inbox_every: std::time::Duration, full_every: std::time::Duration) {
    let mut full = true;
    let mut last_full = tokio::time::Instant::now();
    loop {
        let accounts = svc.graph_accounts().unwrap_or_default();
        for a in accounts {
            if a.sync_state == SyncState::NeedsAuth {
                continue;
            }
            match clients(&a) {
                Ok(client) => {
                    let syncer = Syncer::new(&svc, &client, a.clone());
                    let result = if full { syncer.run().await } else { syncer.run_inbox().await };
                    if let Err(e) = result {
                        tracing::warn!("sync {}: {e}", a.email);
                    }
                }
                Err(e) => tracing::warn!("no client for {}: {e}", a.email),
            }
        }
        if full {
            last_full = tokio::time::Instant::now();
        }
        full = tokio::select! {
            _ = wake.notified() => true,
            _ = tokio::time::sleep(inbox_every) => last_full.elapsed() >= full_every,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_names() {
        assert_eq!(safe_file_name("a/b:c?.pdf"), "a_b_c_.pdf");
        assert_eq!(safe_file_name(".."), "attachment");
    }
}
