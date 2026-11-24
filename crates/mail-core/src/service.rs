//! The local mail service: everything the interface can do,
//! answered from the local databases. Changes apply locally at once and queue a
//! pending operation that the sync engine replays against Microsoft Graph.

use crate::db::account::{fts_query, AccountDb, EventRecord, MessageFilter, MessageRecord};
use crate::db::app::{AppDb, NewAccount};
use crate::db::{self, now_iso};
use crate::error::{Error, Result};
use crate::html;
use crate::ids;
use crate::model::*;
use crate::ops::Op;
use crate::people;
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

/// Notifications from the service to whoever hosts it (Tauri emits these to windows).
pub trait EventSink: Send + Sync {
    fn mail_changed(&self, _account_ids: &[String]) {}
    fn accounts_changed(&self) {}
    fn draft_changed(&self, _draft_id: &str) {}
    fn sync_status(&self) {}
    /// A pending operation was queued; the sync engine should run soon.
    fn work_queued(&self, _account_id: &str) {}
    fn new_mail(&self, _account: &Account, _messages: &[MessageSummary]) {}
}

pub struct NoEvents;
impl EventSink for NoEvents {}

#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
}

impl Paths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Paths { root: root.into() }
    }
    pub fn app_db(&self) -> PathBuf {
        self.root.join("app.db")
    }
    pub fn account_dir(&self, id: &str) -> PathBuf {
        self.root.join("accounts").join(id)
    }
    pub fn account_db(&self, id: &str) -> PathBuf {
        self.account_dir(id).join("mail.db")
    }
    pub fn attachments_dir(&self, id: &str) -> PathBuf {
        self.account_dir(id).join("attachments")
    }
    /// Storage for a web account's isolated web view.
    pub fn webview_dir(&self, id: &str) -> PathBuf {
        self.root.join("webviews").join(id)
    }
}

pub type AccountHandle = Arc<Mutex<AccountDb>>;

pub struct MailService {
    pub paths: Paths,
    app: Mutex<AppDb>,
    accounts: Mutex<HashMap<String, AccountHandle>>,
    people_cache: Mutex<Option<Vec<Person>>>,
    events: Mutex<Arc<dyn EventSink>>,
    online: std::sync::atomic::AtomicBool,
    in_memory: bool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl MailService {
    pub fn open(root: &Path) -> Result<Self> {
        let paths = Paths::new(root);
        let app = AppDb::new(db::open(&paths.app_db())?)?;
        Ok(Self::with(paths, app, false))
    }

    /// Fully in memory, for tests and the demo.
    pub fn in_memory() -> Result<Self> {
        let app = AppDb::new(db::open_memory()?)?;
        Ok(Self::with(Paths::new(std::env::temp_dir().join("mail-app-memory")), app, true))
    }

    fn with(paths: Paths, app: AppDb, in_memory: bool) -> Self {
        MailService {
            paths,
            app: Mutex::new(app),
            accounts: Mutex::new(HashMap::new()),
            people_cache: Mutex::new(None),
            events: Mutex::new(Arc::new(NoEvents)),
            online: std::sync::atomic::AtomicBool::new(true),
            in_memory,
        }
    }

    pub fn set_events(&self, sink: Arc<dyn EventSink>) {
        *lock(&self.events) = sink;
    }

    pub fn events(&self) -> Arc<dyn EventSink> {
        lock(&self.events).clone()
    }

    pub fn app(&self) -> MutexGuard<'_, AppDb> {
        lock(&self.app)
    }

    /// The account database, opened on first use.
    pub fn account_db(&self, account_id: &str) -> Result<AccountHandle> {
        let mut map = lock(&self.accounts);
        if let Some(h) = map.get(account_id) {
            return Ok(h.clone());
        }
        let conn = if self.in_memory { db::open_memory()? } else { db::open(&self.paths.account_db(account_id))? };
        let h = Arc::new(Mutex::new(AccountDb::new(conn, account_id)?));
        map.insert(account_id.to_string(), h.clone());
        Ok(h)
    }

    pub fn with_account<T>(&self, account_id: &str, f: impl FnOnce(&AccountDb) -> Result<T>) -> Result<T> {
        let h = self.account_db(account_id)?;
        let g = lock(&h);
        f(&g)
    }

    pub fn set_online(&self, online: bool) {
        let old = self.online.swap(online, std::sync::atomic::Ordering::Relaxed);
        if old != online {
            self.events().sync_status();
        }
    }

    pub fn is_online(&self) -> bool {
        self.online.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn invalidate_people(&self) {
        *lock(&self.people_cache) = None;
    }

    fn queued(&self, account_id: &str) {
        self.events().work_queued(account_id);
    }

    pub fn enqueue(&self, account_id: &str, op: &Op) -> Result<()> {
        self.with_account(account_id, |db| {
            // One pending save per draft is enough.
            if let Op::SaveDraft { draft_id } = op {
                if db.ops_for_draft(draft_id)?.iter().any(|o| o.kind == "saveDraft" && o.state == "pending") {
                    return Ok(());
                }
            }
            db.enqueue(op.kind(), &serde_json::to_value(op)?)?;
            Ok(())
        })?;
        self.queued(account_id);
        Ok(())
    }

    // ================================================================= accounts

    pub fn me(&self) -> Result<Me> {
        let app = self.app();
        if let Some(raw) = app.kv_get("me")? {
            if let Ok(me) = serde_json::from_str::<Me>(&raw) {
                return Ok(me);
            }
        }
        let first = app.list_accounts()?.into_iter().next();
        Ok(match first {
            Some(a) => Me { name: a.display_name, email: a.email },
            None => Me { name: String::new(), email: String::new() },
        })
    }

    pub fn set_me(&self, me: &Me) -> Result<()> {
        self.app().kv_set("me", &serde_json::to_string(me)?)
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        let mut list = self.app().list_accounts()?;
        for a in list.iter_mut().filter(|a| a.kind == AccountKind::Graph) {
            a.unread = Some(self.with_account(&a.id, |db| {
                let inbox = db.folder_id_by_role(FolderRole::Inbox)?;
                Ok(match inbox {
                    Some(f) => db.count_messages(&MessageFilter { folder_ids: vec![f], unread_only: true, ..Default::default() })?,
                    None => 0,
                })
            })?);
        }
        Ok(list)
    }

    pub fn get_account(&self, id: &str) -> Result<Account> {
        self.list_accounts()?.into_iter().find(|a| a.id == id).ok_or_else(|| Error::NotFound(format!("account {id}")))
    }

    pub fn graph_accounts(&self) -> Result<Vec<Account>> {
        Ok(self.app().list_accounts()?.into_iter().filter(|a| a.kind == AccountKind::Graph).collect())
    }

    pub fn add_web_account(&self, email: &str, display_name: &str) -> Result<Account> {
        let email = email.trim();
        if !email.contains('@') {
            return Err(Error::Invalid("Enter a full email address".into()));
        }
        if self.app().find_account_by_email(email)?.is_some() {
            return Err(Error::Invalid(format!("{email} is already added")));
        }
        let name = if display_name.trim().is_empty() { default_display_name(email) } else { display_name.trim().to_string() };
        let a = self.app().insert_account(NewAccount {
            email: email.into(),
            display_name: name,
            kind: AccountKind::Web,
            tenant_id: None,
            home_account_id: None,
            web_url: Some(format!("https://outlook.office.com/mail/?login_hint={}", urlencoding::encode(email))),
        })?;
        self.events().accounts_changed();
        Ok(a)
    }

    /// Called after a successful Graph sign-in. Upgrades a matching web account in place, and
    /// clears "sign in needed" on an existing one. Doesn't start sync: the caller stores the
    /// tokens first, then wakes the sync engine.
    pub fn add_graph_account(&self, email: &str, display_name: &str, tenant_id: Option<String>, home_account_id: Option<String>) -> Result<Account> {
        let existing = self.app().find_account_by_email(email)?;
        let a = match existing {
            Some(a) if a.kind == AccountKind::Web => self.app().convert_to_graph(&a.id, tenant_id, home_account_id)?,
            Some(a) => {
                self.app().set_sync_state(&a.id, SyncState::Idle, None)?;
                a
            }
            None => self.app().insert_account(NewAccount {
                email: email.into(),
                display_name: if display_name.trim().is_empty() { default_display_name(email) } else { display_name.into() },
                kind: AccountKind::Graph,
                tenant_id,
                home_account_id,
                web_url: None,
            })?,
        };
        self.account_db(&a.id)?;
        self.events().accounts_changed();
        Ok(a)
    }

    pub fn update_account(&self, id: &str, patch: &AccountPatch) -> Result<Account> {
        self.app().update_account(id, patch)?;
        self.events().accounts_changed();
        self.get_account(id)
    }

    /// Deletes the account's database, cached files and web view storage. Tokens are removed by the caller.
    pub fn remove_account(&self, id: &str) -> Result<()> {
        self.app().delete_account(id)?;
        lock(&self.accounts).remove(id);
        if !self.in_memory {
            for dir in [self.paths.account_dir(id), self.paths.webview_dir(id)] {
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)?;
                }
            }
        }
        self.invalidate_people();
        self.events().accounts_changed();
        Ok(())
    }

    pub fn set_web_unread(&self, id: &str, unread: Option<i64>) -> Result<bool> {
        let changed = self.app().set_web_unread(id, unread)?;
        if changed {
            self.events().accounts_changed();
        }
        Ok(changed)
    }

    // ================================================================= folders & lists

    /// One account's folders, or (no account) the standard folders summed across Graph accounts
    /// with ids `all:<role>`.
    pub fn list_folders(&self, account_id: Option<&str>) -> Result<Vec<Folder>> {
        if let Some(id) = account_id {
            return self.with_account(id, |db| db.list_folders());
        }
        let mut sums: Vec<Folder> = vec![];
        for a in self.graph_accounts()? {
            for f in self.with_account(&a.id, |db| db.list_folders())? {
                if let Some(role) = f.role {
                    match sums.iter_mut().find(|s| s.role == Some(role)) {
                        Some(s) => {
                            s.unread += f.unread;
                            s.total += f.total;
                        }
                        None => sums.push(Folder { id: format!("all:{}", role.as_str()), account_id: String::new(), name: f.name.clone(), role: Some(role), parent_id: None, unread: f.unread, total: f.total }),
                    }
                }
            }
        }
        sums.sort_by_key(|f| f.role.map(|r| r.order()).unwrap_or(100));
        Ok(sums)
    }

    /// (account id, raw folder ids) the scope covers. Web accounts are never included.
    fn scope_targets(&self, scope: &ViewScope, account_filter: Option<&str>, all_folders: bool) -> Result<Vec<(String, Vec<String>)>> {
        let mut out = vec![];
        let accounts: Vec<Account> = self.graph_accounts()?;
        let wanted: Option<String> = match &scope.folder {
            FolderSelector::Id { id } if !id.starts_with("all:") => Some(ids::split(id)?.0.to_string()),
            _ => scope.account_id.clone(),
        };
        for a in accounts {
            if wanted.as_deref().is_some_and(|w| w != a.id) || account_filter.is_some_and(|w| w != a.id) {
                continue;
            }
            if all_folders {
                out.push((a.id.clone(), vec![]));
                continue;
            }
            let folder = self.with_account(&a.id, |db| {
                Ok(match &scope.folder {
                    FolderSelector::Role { role } => db.folder_id_by_role(*role)?,
                    FolderSelector::Id { id } if id.starts_with("all:") => match FolderRole::parse(&id[4..]) {
                        Some(r) => db.folder_id_by_role(r)?,
                        None => None,
                    },
                    FolderSelector::Id { id } => Some(ids::split(id)?.1.to_string()),
                })
            })?;
            if let Some(f) = folder {
                out.push((a.id.clone(), vec![f]));
            }
        }
        Ok(out)
    }

    pub fn list_messages(&self, scope: &ViewScope, limit: i64, offset: i64) -> Result<Vec<MessageSummary>> {
        let limit = limit.clamp(1, 500);
        let mut all = vec![];
        for (acc, folders) in self.scope_targets(scope, None, false)? {
            let f = MessageFilter {
                folder_ids: folders.clone(),
                unread_only: scope.tab == ListTab::Unread,
                flagged_only: scope.tab == ListTab::Flagged,
                limit: offset + limit,
                ..Default::default()
            };
            let is_drafts = match folders.first() {
                Some(fid) => self.with_account(&acc, |db| db.folder_role(fid))? == Some(FolderRole::Drafts),
                None => false,
            };
            if is_drafts {
                // Drafts are listed by draft id (local drafts, plus server drafts made elsewhere).
                if scope.tab == ListTab::All {
                    let me = self.app().get_account(&acc)?;
                    all.extend(self.with_account(&acc, |db| db.draft_summaries(&Address::new(me.display_name.clone(), me.email.clone()), offset + limit))?);
                }
            } else {
                all.extend(self.with_account(&acc, |db| db.list_messages(&f))?);
            }
        }
        all.sort_by(|a, b| b.received_at.cmp(&a.received_at));
        Ok(all.into_iter().skip(offset.max(0) as usize).take(limit as usize).collect())
    }

    /// Remote images load by default, except in Junk (a loaded image confirms the address
    /// to a spammer) or when the user chose "ask". Senders they allowed always load.
    fn allow_remote_for(&self, sender: &str, in_junk: bool) -> Result<bool> {
        let s = self.app().settings()?;
        Ok((s.remote_images == "show" && !in_junk) || s.remote_image_senders.iter().any(|e| e.eq_ignore_ascii_case(sender)))
    }

    fn in_junk(&self, m: &Message) -> Result<bool> {
        let (acc, raw_folder) = ids::split(&m.summary.folder_id)?;
        let folders = self.with_account(acc, |db| db.folder_ids())?;
        Ok(folders.iter().any(|(id, role)| id == raw_folder && *role == Some(FolderRole::Junk)))
    }

    fn render(&self, mut m: Message, force_remote: bool) -> Result<Message> {
        let allow = force_remote || self.allow_remote_for(&m.summary.from.email, self.in_junk(&m)?)?;
        let inline = html::inline_data_urls(&m.attachments);
        let body = if m.body_html.is_empty() { crate::text::text_to_html(&m.summary.snippet) } else { m.body_html.clone() };
        let s = html::sanitize_mail_for_display(&body, allow, &inline);
        m.body_html = s.html;
        m.remote_images_blocked = s.remote_images_blocked;
        // Inline images are shown in the body, not as attachment chips.
        m.attachments.retain(|a| !(a.is_inline && a.content_id.is_some()));
        Ok(m)
    }

    /// The stored message without rendering (raw body), for sync and replies.
    pub fn stored_message(&self, id: &str) -> Result<crate::db::account::StoredMessage> {
        let (acc, raw) = ids::split(id)?;
        self.with_account(acc, |db| db.get_message(raw))
    }

    pub fn get_message(&self, id: &str) -> Result<Message> {
        let m = self.stored_message(id)?.message;
        self.render(m, false)
    }

    pub fn show_remote_images_once(&self, id: &str) -> Result<Message> {
        let m = self.stored_message(id)?.message;
        self.render(m, true)
    }

    pub fn allow_remote_images(&self, sender: &str) -> Result<()> {
        let mut list = self.app().settings()?.remote_image_senders;
        list.push(sender.to_lowercase());
        self.app().update_settings(&SettingsPatch { remote_image_senders: Some(list), ..Default::default() })?;
        Ok(())
    }

    pub fn get_thread(&self, message_id: &str) -> Result<Thread> {
        let (acc, raw) = ids::split(message_id)?;
        let (conv, subject, ids_in_conv, drafts) = self.with_account(acc, |db| {
            let m = db.get_message(raw)?;
            let conv = m.message.summary.conversation_id.clone();
            let mut list = db.conversation_message_ids(&conv)?;
            if !list.contains(&raw.to_string()) {
                list.insert(0, raw.to_string());
            }
            Ok((conv.clone(), m.message.summary.subject.clone(), list, db.drafts_for_conversation(&conv)?))
        })?;
        let mut messages = vec![];
        for r in ids_in_conv {
            let m = self.with_account(acc, |db| db.get_message(&r))?.message;
            messages.push(self.render(m, false)?);
        }
        messages.sort_by(|a, b| b.summary.received_at.cmp(&a.summary.received_at));
        Ok(Thread { conversation_id: conv, subject, messages, drafts })
    }

    fn group_by_account(ids_list: &[String]) -> Result<Vec<(String, Vec<String>)>> {
        let mut map: Vec<(String, Vec<String>)> = vec![];
        for id in ids_list {
            let (a, r) = ids::split(id)?;
            match map.iter_mut().find(|(x, _)| x == a) {
                Some((_, v)) => v.push(r.to_string()),
                None => map.push((a.to_string(), vec![r.to_string()])),
            }
        }
        Ok(map)
    }

    fn changed(&self, accounts: Vec<String>) {
        self.events().mail_changed(&accounts);
    }

    pub fn mark_read(&self, ids_list: &[String], read: bool) -> Result<()> {
        let groups = Self::group_by_account(ids_list)?;
        for (acc, raws) in &groups {
            self.with_account(acc, |db| raws.iter().try_for_each(|r| db.set_read(r, read)))?;
            self.enqueue(acc, &Op::MarkRead { ids: raws.clone(), read })?;
        }
        self.changed(groups.into_iter().map(|g| g.0).collect());
        Ok(())
    }

    pub fn set_flag(&self, ids_list: &[String], flagged: bool) -> Result<()> {
        let groups = Self::group_by_account(ids_list)?;
        for (acc, raws) in &groups {
            self.with_account(acc, |db| raws.iter().try_for_each(|r| db.set_flag(r, flagged)))?;
            self.enqueue(acc, &Op::Flag { ids: raws.clone(), flagged })?;
        }
        self.changed(groups.into_iter().map(|g| g.0).collect());
        Ok(())
    }

    fn move_to(&self, ids_list: &[String], dest: impl Fn(&AccountDb) -> Result<(Option<String>, String)>) -> Result<()> {
        let groups = Self::group_by_account(ids_list)?;
        for (acc, raws) in &groups {
            let destination = self.with_account(acc, |db| {
                let (local, remote) = dest(db)?;
                if let Some(local) = local {
                    for r in raws {
                        db.move_message(r, &local)?;
                    }
                }
                Ok(remote)
            })?;
            self.enqueue(acc, &Op::Move { ids: raws.clone(), destination })?;
        }
        self.changed(groups.into_iter().map(|g| g.0).collect());
        Ok(())
    }

    pub fn archive(&self, ids_list: &[String]) -> Result<()> {
        self.move_to(ids_list, |db| Ok((db.folder_id_by_role(FolderRole::Archive)?, FolderRole::Archive.graph_name().to_string())))
    }

    pub fn move_messages(&self, ids_list: &[String], folder_id: &str) -> Result<()> {
        let (facc, fraw) = ids::split(folder_id)?;
        if ids_list.iter().any(|i| ids::split(i).map(|(a, _)| a != facc).unwrap_or(true)) {
            return Err(Error::Invalid("Messages can only move within their own account".into()));
        }
        let fraw = fraw.to_string();
        self.move_to(ids_list, move |_| Ok((Some(fraw.clone()), fraw.clone())))
    }

    /// Delete moves to Deleted Items; deleting from Deleted Items removes for good.
    pub fn delete_messages(&self, ids_list: &[String]) -> Result<()> {
        let groups = Self::group_by_account(ids_list)?;
        for (acc, raws) in &groups {
            let (to_bin, permanent) = self.with_account(acc, |db| {
                let bin = db.folder_id_by_role(FolderRole::Deleted)?;
                let mut to_bin = vec![];
                let mut permanent = vec![];
                for r in raws {
                    let m = db.get_message(r)?;
                    if bin.as_deref() == Some(m.raw_folder_id.as_str()) {
                        db.delete_message(r)?;
                        permanent.push(r.clone());
                    } else {
                        if let Some(b) = &bin {
                            db.move_message(r, b)?;
                        }
                        to_bin.push(r.clone());
                    }
                }
                Ok((to_bin, permanent))
            })?;
            if !to_bin.is_empty() {
                self.enqueue(acc, &Op::Move { ids: to_bin, destination: FolderRole::Deleted.graph_name().into() })?;
            }
            if !permanent.is_empty() {
                self.enqueue(acc, &Op::DeleteMessages { ids: permanent })?;
            }
        }
        self.changed(groups.into_iter().map(|g| g.0).collect());
        Ok(())
    }

    // ================================================================= drafts

    fn default_graph_account(&self) -> Result<Account> {
        self.graph_accounts()?.into_iter().next().ok_or_else(|| Error::Invalid("Add an account first".into()))
    }

    pub fn create_draft(&self, req: &CreateDraftRequest) -> Result<Draft> {
        self.create_draft_by(req, "user")
    }

    pub fn create_draft_by(&self, req: &CreateDraftRequest, created_by: &str) -> Result<Draft> {
        let source = match &req.source_message_id {
            Some(id) => Some(self.stored_message(id)?),
            None => None,
        };
        if req.mode != DraftMode::New && source.is_none() {
            return Err(Error::Invalid("Replies and forwards need a message".into()));
        }
        // From defaults to the account the message came in on.
        let account = match (&source, &req.account_id) {
            (Some(s), _) => self.app().get_account(&s.message.summary.account_id)?,
            (None, Some(a)) => self.app().get_account(a)?,
            (None, None) => self.default_graph_account()?,
        };
        if account.kind != AccountKind::Graph {
            return Err(Error::Invalid("Web accounts send from Outlook on the web".into()));
        }
        let for_reply = req.mode != DraftMode::New;
        let sig = self.app().default_signature(&account.id, for_reply)?;
        let (mut to, mut cc) = (vec![], vec![]);
        let mut subject = String::new();
        let mut conversation_id = None;
        if let Some(s) = &source {
            let m = &s.message;
            subject = html::reply_subject(req.mode, &m.summary.subject);
            conversation_id = Some(m.summary.conversation_id.clone());
            let me = account.email.to_lowercase();
            let sender = if m.reply_to.is_empty() { vec![m.summary.from.clone()] } else { m.reply_to.clone() };
            match req.mode {
                DraftMode::Reply => to = sender,
                DraftMode::ReplyAll => {
                    to = sender;
                    for a in m.summary.to.iter() {
                        if !a.email.eq_ignore_ascii_case(&me) && !to.iter().any(|t: &Address| t.email.eq_ignore_ascii_case(&a.email)) {
                            to.push(a.clone());
                        }
                    }
                    cc = m.cc.iter().filter(|a| !a.email.eq_ignore_ascii_case(&me) && !to.iter().any(|t| t.email.eq_ignore_ascii_case(&a.email))).cloned().collect();
                }
                _ => {}
            }
        }
        let when = source.as_ref().map(|s| format_when(&s.message.summary.received_at)).unwrap_or_default();
        let body = html::compose_body(sig.as_ref().map(|s| (s.id.as_str(), s.html.as_str())));
        let quote = source.as_ref().map(|s| html::quote_block(req.mode, &s.message, &when));
        let raw_id = ids::new_local_id("d");
        let draft = Draft {
            id: ids::join(&account.id, &raw_id),
            account_id: account.id.clone(),
            mode: req.mode,
            source_message_id: req.source_message_id.clone(),
            conversation_id,
            to,
            cc,
            bcc: vec![],
            subject,
            body_html: body,
            signature_id: sig.map(|s| s.id),
            attachments: vec![],
            updated_at: now_iso(),
            saved_to_server: false,
            status: DraftStatus::Editing,
            error: None,
            popped_out: false,
            edited: false,
        };
        let raw_source = source.as_ref().map(|s| s.raw_id.clone());
        self.with_account(&account.id, |db| {
            db.save_draft(&raw_id, &draft, raw_source.as_deref(), created_by)?;
            db.set_draft_quote(&raw_id, quote.as_deref())
        })?;
        // Saved to the server's Drafts folder automatically.
        self.enqueue(&account.id, &Op::SaveDraft { draft_id: raw_id })?;
        Ok(draft)
    }

    /// A draft by id. A server draft made elsewhere (e.g. in Outlook) is adopted on first open.
    pub fn get_draft(&self, id: &str) -> Result<Draft> {
        let (acc, raw) = ids::split(id)?;
        self.with_account(acc, |db| match db.get_draft(raw) {
            Ok((d, _)) => Ok(d),
            Err(Error::NotFound(_)) => {
                let m = db.get_message(raw)?;
                if !m.message.summary.is_draft {
                    return Err(Error::NotFound(format!("draft {raw}")));
                }
                let mm = m.message;
                let d = Draft {
                    id: id.to_string(),
                    account_id: acc.to_string(),
                    mode: DraftMode::New,
                    source_message_id: None,
                    conversation_id: Some(mm.summary.conversation_id.clone()),
                    to: mm.summary.to.clone(),
                    cc: mm.cc.clone(),
                    bcc: mm.bcc.clone(),
                    subject: mm.summary.subject.clone(),
                    body_html: mm.body_html.clone(),
                    signature_id: None,
                    attachments: mm.attachments.iter().filter(|a| !a.is_inline).cloned().collect(),
                    updated_at: now_iso(),
                    saved_to_server: true,
                    status: DraftStatus::Editing,
                    error: None,
                    popped_out: false,
                    edited: true,
                };
                db.save_draft(raw, &d, None, "user")?;
                db.set_draft_server_id(raw, raw)?;
                Ok(d)
            }
            Err(e) => Err(e),
        })
    }

    /// Draft row with its server id.
    pub fn draft_with_server_id(&self, id: &str) -> Result<(Draft, Option<String>)> {
        let (acc, raw) = ids::split(id)?;
        self.with_account(acc, |db| db.get_draft(raw))
    }

    fn editable(d: &Draft) -> Result<()> {
        match d.status {
            DraftStatus::Editing | DraftStatus::Failed => Ok(()),
            DraftStatus::Unknown => Err(Error::Invalid("This message may already have been sent. Check Sent before trying again.".into())),
            _ => Err(Error::Invalid("This message is already being sent".into())),
        }
    }

    pub fn update_draft(&self, draft: &Draft) -> Result<Draft> {
        let (acc, raw) = ids::split(&draft.id)?;
        let current = self.get_draft(&draft.id)?;
        Self::editable(&current)?;
        if draft.account_id != current.account_id {
            return Err(Error::Invalid("Use changeDraftAccount to change From".into()));
        }
        let mut d = current.clone();
        d.to = clean_addresses(&draft.to);
        d.cc = clean_addresses(&draft.cc);
        d.bcc = clean_addresses(&draft.bcc);
        d.subject = draft.subject.clone();
        d.body_html = draft.body_html.clone();
        d.popped_out = draft.popped_out;
        d.edited = true;
        d.status = DraftStatus::Editing;
        d.error = None;
        d.saved_to_server = false;
        d.updated_at = now_iso();
        self.with_account(acc, |db| db.save_draft(raw, &d, None, "user"))?;
        self.enqueue(acc, &Op::SaveDraft { draft_id: raw.to_string() })?;
        self.events().draft_changed(&d.id);
        Ok(d)
    }

    pub fn set_popped_out(&self, id: &str, popped: bool) -> Result<Draft> {
        let (acc, raw) = ids::split(id)?;
        let mut d = self.get_draft(id)?;
        d.popped_out = popped;
        self.with_account(acc, |db| db.save_draft(raw, &d, None, "user"))?;
        self.events().draft_changed(id);
        Ok(d)
    }

    /// Change From. The draft moves to that account's store (new id), and its signature swaps.
    pub fn change_draft_account(&self, id: &str, account_id: &str) -> Result<Draft> {
        let (old_acc, raw) = ids::split(id)?;
        let (old, server_id) = self.draft_with_server_id(id)?;
        Self::editable(&old)?;
        if old_acc == account_id {
            return Ok(old);
        }
        let account = self.app().get_account(account_id)?;
        if account.kind != AccountKind::Graph {
            return Err(Error::Invalid("Web accounts send from Outlook on the web".into()));
        }
        let sig = self.app().default_signature(account_id, old.mode != DraftMode::New)?;
        let mut d = old.clone();
        d.id = ids::join(account_id, raw);
        d.account_id = account_id.to_string();
        d.body_html = html::swap_signature(&old.body_html, sig.as_ref().map(|s| (s.id.as_str(), s.html.as_str())));
        d.signature_id = sig.map(|s| s.id);
        d.saved_to_server = false;
        d.edited = true;
        d.updated_at = now_iso();
        // Replies keep their source only within the same mailbox.
        let raw_source = None;
        let quote = self.with_account(old_acc, |db| db.draft_quote(raw))?;
        self.with_account(account_id, |db| {
            db.save_draft(raw, &d, raw_source, "user")?;
            db.set_draft_quote(raw, quote.as_deref())
        })?;
        self.with_account(old_acc, |db| db.delete_draft(raw))?;
        if let Some(sid) = server_id {
            self.enqueue(old_acc, &Op::DeleteServerDraft { server_id: sid })?;
        }
        self.enqueue(account_id, &Op::SaveDraft { draft_id: raw.to_string() })?;
        self.changed(vec![old_acc.to_string(), account_id.to_string()]);
        Ok(d)
    }

    pub fn add_attachment(&self, id: &str, path: &Path) -> Result<Draft> {
        let (acc, raw) = ids::split(id)?;
        let mut d = self.get_draft(id)?;
        Self::editable(&d)?;
        let meta = std::fs::metadata(path)?;
        if meta.len() > 150 * 1024 * 1024 {
            return Err(Error::Invalid("Attachments over 150 MB can't be sent".into()));
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "attachment".into());
        d.attachments.push(Attachment {
            id: ids::new_local_id("att"),
            content_type: guess_mime(&name).into(),
            name,
            size: meta.len() as i64,
            is_inline: false,
            content_id: None,
            local_path: Some(path.to_string_lossy().to_string()),
        });
        d.saved_to_server = false;
        d.edited = true;
        d.updated_at = now_iso();
        self.with_account(acc, |db| db.save_draft(raw, &d, None, "user"))?;
        self.enqueue(acc, &Op::SaveDraft { draft_id: raw.to_string() })?;
        Ok(d)
    }

    pub fn remove_attachment(&self, id: &str, attachment_id: &str) -> Result<Draft> {
        let (acc, raw) = ids::split(id)?;
        let mut d = self.get_draft(id)?;
        Self::editable(&d)?;
        d.attachments.retain(|a| a.id != attachment_id);
        d.saved_to_server = false;
        d.edited = true;
        d.updated_at = now_iso();
        self.with_account(acc, |db| db.save_draft(raw, &d, None, "user"))?;
        self.enqueue(acc, &Op::SaveDraft { draft_id: raw.to_string() })?;
        Ok(d)
    }

    pub fn discard_draft(&self, id: &str) -> Result<()> {
        let (acc, raw) = ids::split(id)?;
        let (d, server_id) = self.draft_with_server_id(id)?;
        if matches!(d.status, DraftStatus::Queued | DraftStatus::Sending) {
            return Err(Error::Invalid("This message is already being sent".into()));
        }
        self.with_account(acc, |db| {
            for op in db.ops_for_draft(raw)? {
                db.op_done(op.id)?;
            }
            db.delete_draft(raw)?;
            if let Some(s) = &server_id {
                db.delete_message(s)?;
            }
            Ok(())
        })?;
        if let Some(s) = server_id {
            self.enqueue(acc, &Op::DeleteServerDraft { server_id: s })?;
        }
        self.changed(vec![acc.to_string()]);
        Ok(())
    }

    /// Queue for sending. Works offline; the sync engine sends on reconnect.
    pub fn send_draft(&self, id: &str) -> Result<Draft> {
        let (acc, raw) = ids::split(id)?;
        let mut d = self.get_draft(id)?;
        // A held (unknown) send is only re-sent when the user explicitly sends again.
        if !matches!(d.status, DraftStatus::Editing | DraftStatus::Failed | DraftStatus::Unknown) {
            return Err(Error::Invalid("This message is already being sent".into()));
        }
        if d.to.is_empty() && d.cc.is_empty() && d.bcc.is_empty() {
            return Err(Error::Invalid("Add at least one recipient".into()));
        }
        if let Some(bad) = d.to.iter().chain(&d.cc).chain(&d.bcc).find(|a| !valid_email(&a.email)) {
            return Err(Error::Invalid(format!("{} isn't a valid address", bad.email)));
        }
        d.status = DraftStatus::Queued;
        d.error = None;
        self.with_account(acc, |db| {
            db.save_draft(raw, &d, None, "user")?;
            // Remove any earlier held send for this draft before queueing a new one.
            for op in db.ops_for_draft(raw)? {
                if op.kind == "send" {
                    db.op_done(op.id)?;
                }
            }
            Ok(())
        })?;
        self.enqueue(acc, &Op::Send { draft_id: raw.to_string() })?;
        self.events().draft_changed(id);
        self.events().sync_status();
        Ok(d)
    }

    // ================================================================= search & people

    pub fn search(&self, q: &SearchQuery) -> Result<SearchResult> {
        let after = match q.date.unwrap_or_default() {
            DateFilter::Any => None,
            DateFilter::Week => Some(Utc::now() - Duration::days(7)),
            DateFilter::Month => Some(Utc::now() - Duration::days(31)),
            DateFilter::Year => Some(Utc::now() - Duration::days(366)),
        }
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        let fts = fts_query(&q.text);
        let mut all = vec![];
        let mut total = 0;
        for (acc, folders) in self.scope_targets(&q.scope, q.account_id.as_deref(), q.all_folders)? {
            let f = MessageFilter {
                folder_ids: folders,
                unread_only: q.unread.unwrap_or(false) || q.scope.tab == ListTab::Unread,
                flagged_only: q.scope.tab == ListTab::Flagged,
                fts: fts.clone(),
                from_email: q.from.clone(),
                to_email: q.to.clone(),
                has_attachment: q.has_attachment.unwrap_or(false),
                received_after: after.clone(),
                limit: 300,
            };
            let (list, n) = self.with_account(&acc, |db| Ok((db.list_messages(&f)?, db.count_messages(&f)?)))?;
            total += n;
            all.extend(list);
        }
        all.sort_by(|a, b| b.received_at.cmp(&a.received_at));
        all.truncate(300);
        let contact = match q.from.as_deref().or(q.to.as_deref()) {
            Some(e) => self.get_person(e)?,
            None => None,
        };
        Ok(SearchResult { messages: all, total, contact, from_server: false })
    }

    fn all_people(&self) -> Result<Vec<Person>> {
        if let Some(p) = lock(&self.people_cache).clone() {
            return Ok(p);
        }
        let accounts = self.graph_accounts()?;
        let me: Vec<String> = self.app().list_accounts()?.into_iter().map(|a| a.email).collect();
        let mut rows = vec![];
        for a in &accounts {
            for (addr, at, out) in self.with_account(&a.id, |db| db.header_people(&a.email))? {
                rows.push((addr, at, out, a.id.clone()));
            }
        }
        let list = people::build(rows, &me, Utc::now());
        *lock(&self.people_cache) = Some(list.clone());
        Ok(list)
    }

    pub fn list_people(&self, query: &str, limit: usize) -> Result<Vec<Person>> {
        let all = self.all_people()?;
        Ok(people::filter(&all, query).take(limit.clamp(1, 500)).cloned().collect())
    }

    pub fn get_person(&self, email: &str) -> Result<Option<Person>> {
        Ok(self.all_people()?.into_iter().find(|p| p.email.eq_ignore_ascii_case(email)))
    }

    // ================================================================= calendar

    pub fn list_calendars(&self) -> Result<Vec<CalendarInfo>> {
        let mut out = vec![];
        let accounts = self.app().list_accounts()?;
        for a in accounts {
            if a.kind == AccountKind::Web {
                continue;
            }
            for (raw, name, is_default) in self.with_account(&a.id, |db| db.list_calendars())? {
                let id = ids::join(&a.id, &raw);
                let visible = self.app().calendar_visible(&id)?;
                out.push(CalendarInfo { id, account_id: a.id.clone(), name, color: a.color.clone(), visible, is_default });
            }
        }
        Ok(out)
    }

    pub fn set_calendar_visible(&self, id: &str, visible: bool) -> Result<()> {
        self.app().set_calendar_visible(id, visible)?;
        self.changed(vec![ids::split(id)?.0.to_string()]);
        Ok(())
    }

    /// Events in visible calendars overlapping [start, end).
    pub fn list_events(&self, start: &str, end: &str) -> Result<Vec<CalendarEvent>> {
        let start = normalize_time(start)?;
        let end = normalize_time(end)?;
        let mut out = vec![];
        for a in self.graph_accounts()? {
            let evs = self.with_account(&a.id, |db| db.list_events(&start, &end, &a.color))?;
            for e in evs {
                if self.app().calendar_visible(&e.calendar_id)? && !e.is_cancelled {
                    out.push(e);
                }
            }
        }
        out.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.end.cmp(&b.end)));
        Ok(out)
    }

    pub fn agenda(&self, days: i64) -> Result<Vec<AgendaDay>> {
        self.agenda_at(days, Local::now())
    }

    pub fn agenda_at<Tz: TimeZone>(&self, days: i64, now: DateTime<Tz>) -> Result<Vec<AgendaDay>>
    where
        Tz::Offset: Copy,
    {
        let tz = now.timezone();
        let today = now.date_naive();
        let mut out = vec![];
        for d in 0..days.clamp(1, 31) {
            let date = today + Duration::days(d);
            let start = local_midnight(&tz, date);
            let end = local_midnight(&tz, date + Duration::days(1));
            let mut events = self.list_events(&start.to_rfc3339(), &end.to_rfc3339())?;
            if d == 0 {
                let now_utc = now.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                events.retain(|e| e.end > now_utc || e.is_all_day);
            }
            let label = match d {
                0 => "Today".to_string(),
                1 => "Tomorrow".to_string(),
                2..=6 => weekday_name(date.weekday()).to_string(),
                _ => format!("{} {} {}", &weekday_name(date.weekday())[..3], date.day(), month_name(date.month())),
            };
            out.push(AgendaDay { label, date: date.to_string(), events });
        }
        Ok(out)
    }

    fn event_color(&self, account_id: &str) -> Result<String> {
        Ok(self.app().get_account(account_id)?.color)
    }

    pub fn get_event(&self, id: &str) -> Result<CalendarEvent> {
        let (acc, raw) = ids::split(id)?;
        let color = self.event_color(acc)?;
        self.with_account(acc, |db| db.get_event(raw, &color))
    }

    fn event_record(&self, raw_id: &str, input: &EventInput, raw_calendar: &str, organizer: Address) -> Result<EventRecord> {
        let start = normalize_time(&input.start)?;
        let end = normalize_time(&input.end)?;
        if end <= start {
            return Err(Error::Invalid("The event must end after it starts".into()));
        }
        if input.subject.trim().is_empty() {
            return Err(Error::Invalid("Give the event a title".into()));
        }
        Ok(EventRecord {
            id: raw_id.to_string(),
            calendar_id: raw_calendar.to_string(),
            subject: input.subject.trim().to_string(),
            start,
            end,
            is_all_day: input.is_all_day,
            location: input.location.clone(),
            body_html: input.body_html.clone(),
            organizer,
            attendees: clean_addresses(&input.attendees)
                .into_iter()
                .map(|a| Attendee { address: a, kind: AttendeeType::Required, response: ResponseStatus::None })
                .collect(),
            my_response: ResponseStatus::Organizer,
            is_online_meeting: input.is_online_meeting,
            online_meeting_url: None,
            reminder_minutes: input.reminder_minutes.or(Some(15)),
            is_cancelled: false,
            local_only: true,
        })
    }

    pub fn create_event(&self, input: &EventInput) -> Result<CalendarEvent> {
        let account = self.app().get_account(&input.account_id)?;
        if account.kind != AccountKind::Graph {
            return Err(Error::Invalid("Web accounts manage their calendar in Outlook on the web".into()));
        }
        let raw_cal = match &input.calendar_id {
            Some(c) => ids::split(c)?.1.to_string(),
            None => self.with_account(&account.id, |db| db.default_calendar())?.ok_or_else(|| Error::Invalid("This account's calendar hasn't synced yet".into()))?,
        };
        let raw_id = ids::new_local_id("local-ev");
        let rec = self.event_record(&raw_id, input, &raw_cal, Address::new(account.display_name.clone(), account.email.clone()))?;
        self.with_account(&account.id, |db| db.upsert_event(&rec))?;
        self.enqueue(&account.id, &Op::CreateEvent { event_id: raw_id.clone() })?;
        self.changed(vec![account.id.clone()]);
        self.get_event(&ids::join(&account.id, &raw_id))
    }

    pub fn update_event(&self, id: &str, input: &EventInput) -> Result<CalendarEvent> {
        let (acc, raw) = ids::split(id)?;
        let old = self.get_event(id)?;
        let raw_cal = ids::split(&old.calendar_id)?.1.to_string();
        let mut rec = self.event_record(raw, input, &raw_cal, old.organizer.clone())?;
        rec.local_only = raw.starts_with("local-ev");
        rec.my_response = old.my_response;
        rec.online_meeting_url = old.online_meeting_url.clone();
        // Keep attendee responses we already know.
        for a in rec.attendees.iter_mut() {
            if let Some(o) = old.attendees.iter().find(|o| o.address.email.eq_ignore_ascii_case(&a.address.email)) {
                a.response = o.response;
                a.kind = o.kind;
            }
        }
        self.with_account(acc, |db| db.upsert_event(&rec))?;
        if !rec.local_only {
            self.enqueue(acc, &Op::UpdateEvent { event_id: raw.to_string() })?;
        }
        self.changed(vec![acc.to_string()]);
        self.get_event(id)
    }

    pub fn respond_event(&self, id: &str, response: EventResponse) -> Result<CalendarEvent> {
        let (acc, raw) = ids::split(id)?;
        let ev = self.get_event(id)?;
        if ev.my_response == ResponseStatus::Organizer {
            return Err(Error::Invalid("You organised this event".into()));
        }
        self.with_account(acc, |db| db.set_event_response(raw, response.as_status()))?;
        self.enqueue(acc, &Op::RespondEvent { event_id: raw.to_string(), response })?;
        self.changed(vec![acc.to_string()]);
        self.get_event(id)
    }

    pub fn delete_event(&self, id: &str) -> Result<()> {
        let (acc, raw) = ids::split(id)?;
        self.with_account(acc, |db| db.delete_event(raw))?;
        if raw.starts_with("local-ev") {
            // Never reached the server: drop the queued create.
            self.with_account(acc, |db| {
                for op in db.all_ops()? {
                    if op.payload.get("eventId").and_then(|v| v.as_str()) == Some(raw) {
                        db.op_done(op.id)?;
                    }
                }
                Ok(())
            })?;
        } else {
            self.enqueue(acc, &Op::DeleteEvent { event_id: raw.to_string() })?;
        }
        self.changed(vec![acc.to_string()]);
        Ok(())
    }

    /// Events whose reminder falls in (since, now].
    pub fn due_reminders(&self, since: DateTime<Utc>, now: DateTime<Utc>) -> Result<Vec<CalendarEvent>> {
        let window_end = (now + Duration::days(2)).to_rfc3339();
        let mut out = vec![];
        for e in self.list_events(&since.to_rfc3339(), &window_end)? {
            let (Some(mins), Ok(start)) = (e.reminder_minutes, DateTime::parse_from_rfc3339(&e.start)) else { continue };
            if e.my_response == ResponseStatus::Declined {
                continue;
            }
            let at = start.with_timezone(&Utc) - Duration::minutes(mins);
            if at > since && at <= now {
                out.push(e);
            }
        }
        Ok(out)
    }

    // ================================================================= signatures & settings

    pub fn list_signatures(&self, account_id: Option<&str>) -> Result<Vec<Signature>> {
        self.app().list_signatures(account_id)
    }
    pub fn save_signature(&self, s: &Signature) -> Result<Signature> {
        self.app().save_signature(s)
    }
    pub fn delete_signature(&self, id: &str) -> Result<()> {
        self.app().delete_signature(id)
    }
    pub fn settings(&self) -> Result<Settings> {
        self.app().settings()
    }
    pub fn update_settings(&self, p: &SettingsPatch) -> Result<Settings> {
        self.app().update_settings(p)
    }

    pub fn sync_status(&self) -> Result<SyncStatus> {
        let accounts = self.graph_accounts()?;
        let mut held = 0;
        for a in &accounts {
            held += self.with_account(&a.id, |db| db.count_held_sends())?;
        }
        let syncing = accounts.iter().any(|a| a.sync_state == SyncState::Syncing);
        let online = self.is_online();
        let needs_auth = accounts.iter().filter(|a| a.sync_state == SyncState::NeedsAuth).count();
        let errors = accounts.iter().filter(|a| a.sync_state == SyncState::Error).count();
        let last = accounts.iter().filter_map(|a| a.last_synced_at.clone()).min();
        let any_account = !self.app().list_accounts()?.is_empty();
        let label = if accounts.is_empty() && any_account {
            "Web accounts only".to_string()
        } else if accounts.is_empty() {
            "No accounts yet".to_string()
        } else if !online {
            "Offline · changes will sync".to_string()
        } else if held > 0 {
            format!("{held} message{} held · check Sent", if held == 1 { "" } else { "s" })
        } else if needs_auth > 0 {
            "Sign in needed".to_string()
        } else if syncing {
            "Syncing…".to_string()
        } else if errors > 0 {
            "Sync problem".to_string()
        } else {
            "Synced · offline ready".to_string()
        };
        Ok(SyncStatus { online, syncing, label, last_synced_at: last, outbox_held: held, demo: false })
    }

    // ================================================================= used by sync

    pub fn store_messages(&self, account_id: &str, records: &[MessageRecord]) -> Result<()> {
        self.with_account(account_id, |db| records.iter().try_for_each(|r| db.upsert_message(r)))?;
        self.invalidate_people();
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers

pub fn default_display_name(email: &str) -> String {
    let domain = email.split('@').nth(1).unwrap_or(email);
    let base = domain.split('.').next().unwrap_or(domain);
    let mut c = base.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => email.to_string(),
    }
}

pub fn valid_email(e: &str) -> bool {
    let e = e.trim();
    match e.split_once('@') {
        Some((l, d)) => !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !e.contains(char::is_whitespace),
        None => false,
    }
}

fn clean_addresses(list: &[Address]) -> Vec<Address> {
    let mut out: Vec<Address> = vec![];
    for a in list {
        let email = a.email.trim().to_string();
        if email.is_empty() || out.iter().any(|o| o.email.eq_ignore_ascii_case(&email)) {
            continue;
        }
        out.push(Address { name: a.name.trim().to_string(), email });
    }
    out
}

/// Accept RFC 3339 or a naive local date-time; store as UTC RFC 3339.
pub fn normalize_time(s: &str) -> Result<String> {
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Ok(t.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(n) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            if let Some(t) = Local.from_local_datetime(&n).earliest() {
                return Ok(t.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
            }
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(local_midnight(&Local, d).with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    Err(Error::Invalid(format!("Not a date: {s}")))
}

fn local_midnight<Tz: TimeZone>(tz: &Tz, date: NaiveDate) -> DateTime<Tz> {
    let n = date.and_hms_opt(0, 0, 0).unwrap();
    tz.from_local_datetime(&n).earliest().unwrap_or_else(|| tz.from_utc_datetime(&n))
}

fn format_when(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso).map(|t| t.with_timezone(&Local).format("%-d %b %Y %H:%M").to_string()).unwrap_or_default()
}

fn weekday_name(w: chrono::Weekday) -> &'static str {
    use chrono::Weekday::*;
    match w {
        Mon => "Monday",
        Tue => "Tuesday",
        Wed => "Wednesday",
        Thu => "Thursday",
        Fri => "Friday",
        Sat => "Saturday",
        Sun => "Sunday",
    }
}

fn month_name(m: u32) -> &'static str {
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m as usize).saturating_sub(1) % 12]
}

pub fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "ics" => "text/calendar",
        _ => "application/octet-stream",
    }
}
