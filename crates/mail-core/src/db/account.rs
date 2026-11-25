//! Per-account database: folders, messages (+ FTS5 index), attachments, drafts,
//! pending operations, calendars and events. Methods take raw (Graph or local) IDs
//! and return model types carrying public IDs (`<accountId>:<rawId>`).

use super::{from_json, migrate, now_iso, to_json};
use crate::error::{Error, Result};
use crate::ids;
use crate::model::*;
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  parent_id TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  delta_link TEXT
);
CREATE TABLE messages (
  pk INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  folder_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  internet_message_id TEXT,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  received_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_draft INTEGER NOT NULL DEFAULT 0,
  web_link TEXT
);
CREATE INDEX messages_folder ON messages(folder_id, received_at DESC);
CREATE INDEX messages_conv ON messages(conversation_id);
CREATE INDEX messages_from ON messages(from_email);
CREATE VIRTUAL TABLE messages_fts USING fts5(subject, body, people, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE attachments (
  message_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  is_inline INTEGER NOT NULL,
  content_id TEXT,
  local_path TEXT,
  PRIMARY KEY (message_id, id)
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  mode TEXT NOT NULL,
  source_message_id TEXT,
  conversation_id TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  bcc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  signature_id TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  saved_to_server INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'editing',
  error TEXT,
  popped_out INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'user'
);
CREATE TABLE pending_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  organizer_json TEXT NOT NULL DEFAULT '{}',
  attendees_json TEXT NOT NULL DEFAULT '[]',
  my_response TEXT NOT NULL DEFAULT 'none',
  is_online_meeting INTEGER NOT NULL DEFAULT 0,
  online_meeting_url TEXT,
  reminder_minutes INTEGER,
  is_cancelled INTEGER NOT NULL DEFAULT 0,
  local_only INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_range ON events(start_at, end_at);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#,
    // Quoted original for replies and forwards, kept out of the editable body.
    "ALTER TABLE drafts ADD COLUMN quote_html TEXT",
    // Attachment list fetched from the server (it can be empty even when hasAttachments is set).
    "ALTER TABLE messages ADD COLUMN attachments_checked INTEGER NOT NULL DEFAULT 0",
    // The server refused the content (e.g. a cloud link): don't retry it in background sync.
    "ALTER TABLE attachments ADD COLUMN download_failed INTEGER NOT NULL DEFAULT 0",
    // False until the user changes a new draft; existing drafts count as edited.
    "ALTER TABLE drafts ADD COLUMN edited INTEGER NOT NULL DEFAULT 1",
    // Search by field: split "people" into sender and recipients (To and Cc), rebuilt from what's stored.
    r#"
CREATE VIRTUAL TABLE messages_fts_new USING fts5(subject, body, sender, recipients, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO messages_fts_new (rowid, subject, body, sender, recipients)
  SELECT f.rowid, f.subject, f.body, m.from_name || ' ' || m.from_email,
    coalesce((SELECT group_concat(coalesce(json_extract(j.value, '$.name'), '') || ' ' || coalesce(json_extract(j.value, '$.email'), ''), ' ')
       FROM (SELECT value FROM json_each(m.to_json) UNION ALL SELECT value FROM json_each(m.cc_json)) j), '')
  FROM messages_fts f JOIN messages m ON m.pk = f.rowid;
DROP TABLE messages_fts;
ALTER TABLE messages_fts_new RENAME TO messages_fts;
"#,
    // The From filter, newest first, straight from the index.
    "CREATE INDEX messages_from_date ON messages(from_email, received_at DESC); DROP INDEX messages_from",
    // Meeting messages: Graph's type for the message (NULL = not known yet, '' = plain mail),
    // and the event details read for it when it was opened.
    "ALTER TABLE messages ADD COLUMN meeting_type TEXT; ALTER TABLE messages ADD COLUMN meeting_json TEXT",
];

/// A message as stored, with raw IDs. Built by sync from Graph, or by tests and the demo seed.
#[derive(Debug, Clone, Default)]
pub struct MessageRecord {
    pub id: String,
    pub folder_id: String,
    pub conversation_id: String,
    pub internet_message_id: Option<String>,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub subject: String,
    pub snippet: String,
    /// None = header only (outside the offline window).
    pub body_html: Option<String>,
    pub received_at: String,
    pub is_read: bool,
    pub is_flagged: bool,
    pub has_attachments: bool,
    pub is_draft: bool,
    pub web_link: Option<String>,
    /// Graph's derived type, e.g. "eventMessageRequest"; Some("") for plain mail; None when the
    /// item didn't say (kept as it was, and checked when the message is opened).
    pub meeting_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub message: Message,
    pub raw_id: String,
    pub raw_folder_id: String,
    pub has_body: bool,
    pub internet_message_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EventRecord {
    pub id: String,
    pub calendar_id: String,
    pub subject: String,
    pub start: String,
    pub end: String,
    pub is_all_day: bool,
    pub location: String,
    pub body_html: String,
    pub organizer: Address,
    pub attendees: Vec<Attendee>,
    pub my_response: ResponseStatus,
    pub is_online_meeting: bool,
    pub online_meeting_url: Option<String>,
    pub reminder_minutes: Option<i64>,
    pub is_cancelled: bool,
    pub local_only: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingOp {
    pub id: i64,
    pub kind: String,
    pub payload: serde_json::Value,
    pub state: String,
    pub attempts: i64,
    pub last_error: Option<String>,
}

/// Filter for listing messages within one account.
#[derive(Debug, Clone, Default)]
pub struct MessageFilter {
    /// Raw folder ids; empty = all folders.
    pub folder_ids: Vec<String>,
    pub unread_only: bool,
    pub flagged_only: bool,
    pub fts: Option<String>,
    pub from_email: Option<String>,
    pub to_email: Option<String>,
    pub has_attachment: bool,
    pub received_after: Option<String>,
    pub limit: i64,
}

pub struct AccountDb {
    pub conn: Connection,
    pub account_id: String,
}

/// The one list of event columns, shared by `EVENT_COLS` and `EVENT_VIEW_COLS` so they can't drift.
macro_rules! event_cols {
    () => {
        "id, calendar_id, subject, start_at, end_at, is_all_day, location, body_html, organizer_json, attendees_json, my_response, is_online_meeting, online_meeting_url, reminder_minutes, is_cancelled"
    };
}

const MSG_COLS: &str = "m.id, m.folder_id, m.conversation_id, m.from_name, m.from_email, m.to_json, m.subject, m.snippet, m.received_at, m.is_read, m.is_flagged, m.has_attachments, m.is_draft";

impl AccountDb {
    pub fn new(conn: Connection, account_id: &str) -> Result<Self> {
        migrate(&conn, MIGRATIONS)?;
        Ok(AccountDb { conn, account_id: account_id.to_string() })
    }

    fn pid(&self, raw: &str) -> String {
        ids::join(&self.account_id, raw)
    }

    // ---------------------------------------------------------------- kv

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }
    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)", [key, value])?;
        Ok(())
    }
    pub fn kv_delete(&self, key: &str) -> Result<()> {
        self.conn.execute("DELETE FROM kv WHERE key = ?1", [key])?;
        Ok(())
    }

    // ---------------------------------------------------------------- folders

    pub fn upsert_folder(&self, id: &str, name: &str, role: Option<FolderRole>, parent_id: Option<&str>, total: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO folders (id, name, role, parent_id, total) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = COALESCE(excluded.role, folders.role), parent_id = excluded.parent_id, total = excluded.total",
            params![id, name, role.map(|r| r.as_str()), parent_id, total],
        )?;
        Ok(())
    }

    /// Remove folders not in `keep`, with their messages.
    pub fn retain_folders(&self, keep: &[String]) -> Result<()> {
        let existing: Vec<String> = self.conn.prepare("SELECT id FROM folders")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        for id in existing.into_iter().filter(|id| !keep.contains(id)) {
            let pks: Vec<String> = self.conn.prepare("SELECT id FROM messages WHERE folder_id = ?1")?.query_map([&id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            for m in pks {
                self.delete_message(&m)?;
            }
            self.conn.execute("DELETE FROM folders WHERE id = ?1", [&id])?;
        }
        Ok(())
    }

    pub fn list_folders(&self) -> Result<Vec<Folder>> {
        let mut st = self.conn.prepare(
            "SELECT f.id, f.name, f.role, f.parent_id, f.total,
                    (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.is_read = 0 AND m.is_draft = 0)
             FROM folders f",
        )?;
        let mut rows = st
            .query_map([], |r| {
                Ok(Folder {
                    id: self.pid(&r.get::<_, String>(0)?),
                    account_id: self.account_id.clone(),
                    name: r.get(1)?,
                    role: r.get::<_, Option<String>>(2)?.and_then(|s| FolderRole::parse(&s)),
                    parent_id: r.get::<_, Option<String>>(3)?.map(|p| self.pid(&p)),
                    total: r.get(4)?,
                    unread: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Drafts count is the number of drafts, not unread.
        for f in rows.iter_mut() {
            if f.role == Some(FolderRole::Drafts) {
                let raw = ids::split(&f.id)?.1.to_string();
                let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM messages WHERE folder_id = ?1", [raw], |r| r.get(0))?;
                let local: i64 = self.conn.query_row("SELECT COUNT(*) FROM drafts WHERE server_id IS NULL AND status IN ('editing','failed')", [], |r| r.get(0))?;
                f.unread = n + local;
            }
        }
        rows.sort_by(|a, b| {
            let ka = a.role.map(|r| r.order()).unwrap_or(100);
            let kb = b.role.map(|r| r.order()).unwrap_or(100);
            ka.cmp(&kb).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(rows)
    }

    pub fn folder_id_by_role(&self, role: FolderRole) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT id FROM folders WHERE role = ?1", [role.as_str()], |r| r.get(0)).optional()?)
    }

    pub fn folder_role(&self, raw_id: &str) -> Result<Option<FolderRole>> {
        Ok(self
            .conn
            .query_row("SELECT role FROM folders WHERE id = ?1", [raw_id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
            .and_then(|s| FolderRole::parse(&s)))
    }

    pub fn folder_delta(&self, raw_id: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT delta_link FROM folders WHERE id = ?1", [raw_id], |r| r.get(0)).optional()?.flatten())
    }

    pub fn set_folder_delta(&self, raw_id: &str, link: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE folders SET delta_link = ?2 WHERE id = ?1", params![raw_id, link])?;
        Ok(())
    }

    pub fn folder_ids(&self) -> Result<Vec<(String, Option<FolderRole>)>> {
        let mut st = self.conn.prepare("SELECT id, role FROM folders")?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.and_then(|s| FolderRole::parse(&s)))))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ---------------------------------------------------------------- messages

    pub fn upsert_message(&self, m: &MessageRecord) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let existing_body: Option<Option<String>> = tx.query_row("SELECT body_html FROM messages WHERE id = ?1", [&m.id], |r| r.get(0)).optional()?;
        // Never drop a body we already have when a header-only update arrives.
        let body = m.body_html.clone().or(existing_body.flatten());
        tx.execute(
            "INSERT INTO messages (id, folder_id, conversation_id, internet_message_id, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
                                   subject, snippet, body_html, received_at, is_read, is_flagged, has_attachments, is_draft, web_link, meeting_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
             ON CONFLICT(id) DO UPDATE SET folder_id = excluded.folder_id, conversation_id = excluded.conversation_id,
               internet_message_id = excluded.internet_message_id, from_name = excluded.from_name, from_email = excluded.from_email,
               to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json, reply_to_json = excluded.reply_to_json,
               subject = excluded.subject, snippet = excluded.snippet, body_html = excluded.body_html, received_at = excluded.received_at,
               is_read = excluded.is_read, is_flagged = excluded.is_flagged, has_attachments = excluded.has_attachments,
               is_draft = excluded.is_draft, web_link = excluded.web_link,
               meeting_type = coalesce(excluded.meeting_type, messages.meeting_type)",
            params![
                m.id,
                m.folder_id,
                m.conversation_id,
                m.internet_message_id,
                m.from.name,
                m.from.email.to_lowercase(),
                to_json(&m.to),
                to_json(&m.cc),
                to_json(&m.bcc),
                to_json(&m.reply_to),
                m.subject,
                m.snippet,
                body,
                m.received_at,
                m.is_read,
                m.is_flagged,
                m.has_attachments,
                m.is_draft,
                m.web_link,
                m.meeting_type
            ],
        )?;
        let pk: i64 = tx.query_row("SELECT pk FROM messages WHERE id = ?1", [&m.id], |r| r.get(0))?;
        let body_text = body.as_deref().map(crate::text::html_to_text).unwrap_or_else(|| m.snippet.clone());
        let sender = format!("{} {}", m.from.name, m.from.email);
        let recipients = m.to.iter().chain(m.cc.iter()).map(|a| format!("{} {}", a.name, a.email)).collect::<Vec<_>>().join(" ");
        tx.execute("DELETE FROM messages_fts WHERE rowid = ?1", [pk])?;
        tx.execute(
            "INSERT INTO messages_fts (rowid, subject, body, sender, recipients) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![pk, m.subject, body_text, sender, recipients],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_message(&self, raw_id: &str) -> Result<()> {
        if let Some(pk) = self.conn.query_row("SELECT pk FROM messages WHERE id = ?1", [raw_id], |r| r.get::<_, i64>(0)).optional()? {
            self.conn.execute("DELETE FROM messages_fts WHERE rowid = ?1", [pk])?;
            self.conn.execute("DELETE FROM messages WHERE pk = ?1", [pk])?;
            self.conn.execute("DELETE FROM attachments WHERE message_id = ?1", [raw_id])?;
        }
        Ok(())
    }

    fn row_summary(&self, r: &Row) -> rusqlite::Result<MessageSummary> {
        Ok(MessageSummary {
            id: self.pid(&r.get::<_, String>(0)?),
            account_id: self.account_id.clone(),
            folder_id: self.pid(&r.get::<_, String>(1)?),
            conversation_id: r.get(2)?,
            from: Address { name: r.get(3)?, email: r.get(4)? },
            to: from_json(r.get(5)?),
            subject: r.get(6)?,
            snippet: r.get(7)?,
            received_at: r.get(8)?,
            is_read: r.get(9)?,
            is_flagged: r.get(10)?,
            has_attachments: r.get(11)?,
            is_draft: r.get(12)?,
            has_draft: false,
        })
    }

    pub fn list_messages(&self, f: &MessageFilter) -> Result<Vec<MessageSummary>> {
        let (sql, args) = self.filter_sql(f, &format!("SELECT {MSG_COLS}"), true);
        let mut st = self.conn.prepare(&sql)?;
        let mut rows = st.query_map(params_from_iter(args), |r| self.row_summary(r))?.collect::<rusqlite::Result<Vec<_>>>()?;
        self.mark_unfinished_drafts(&mut rows)?;
        Ok(rows)
    }

    fn mark_unfinished_drafts(&self, rows: &mut [MessageSummary]) -> Result<()> {
        let with_drafts = self.conversations_with_unfinished_drafts()?;
        for m in rows.iter_mut().filter(|m| !m.is_draft) {
            m.has_draft = with_drafts.contains(&m.conversation_id);
        }
        Ok(())
    }

    /// A page of matches and the total number of matches, in one pass.
    pub fn list_messages_counted(&self, f: &MessageFilter) -> Result<(Vec<MessageSummary>, i64)> {
        let (sql, args) = self.filter_sql(f, &format!("SELECT {MSG_COLS}, COUNT(*) OVER ()"), true);
        let mut st = self.conn.prepare(&sql)?;
        let mut total = 0;
        let rows = st
            .query_map(params_from_iter(args), |r| Ok((self.row_summary(r)?, r.get::<_, i64>(13)?)))?
            .map(|r| r.map(|(m, n)| {
                total = n;
                m
            }))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut rows = rows;
        self.mark_unfinished_drafts(&mut rows)?;
        Ok((rows, total))
    }

    /// Conversations with a draft the user has started and not sent: edited, and
    /// still editable (a queued or sending draft is on its way out).
    pub fn conversations_with_unfinished_drafts(&self) -> Result<std::collections::HashSet<String>> {
        let mut st = self.conn.prepare(
            "SELECT DISTINCT conversation_id FROM drafts
             WHERE conversation_id IS NOT NULL AND edited = 1 AND status IN ('editing', 'failed')",
        )?;
        let ids = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    pub fn count_messages(&self, f: &MessageFilter) -> Result<i64> {
        let (sql, args) = self.filter_sql(f, "SELECT COUNT(*)", false);
        Ok(self.conn.query_row(&sql, params_from_iter(args), |r| r.get(0))?)
    }

    fn filter_sql(&self, f: &MessageFilter, select: &str, paged: bool) -> (String, Vec<Value>) {
        let mut sql = format!("{select} FROM messages m");
        let mut wh: Vec<String> = vec![];
        let mut args: Vec<Value> = vec![];
        if let Some(q) = &f.fts {
            sql.push_str(" JOIN messages_fts ON messages_fts.rowid = m.pk");
            wh.push("messages_fts MATCH ?".into());
            args.push(Value::Text(q.clone()));
        }
        if !f.folder_ids.is_empty() {
            wh.push(format!("m.folder_id IN ({})", vec!["?"; f.folder_ids.len()].join(",")));
            args.extend(f.folder_ids.iter().map(|s| Value::Text(s.clone())));
        }
        if f.unread_only {
            wh.push("m.is_read = 0".into());
        }
        if f.flagged_only {
            wh.push("m.is_flagged = 1".into());
        }
        if f.has_attachment {
            wh.push("m.has_attachments = 1".into());
        }
        if let Some(e) = &f.from_email {
            wh.push("m.from_email = ?".into());
            args.push(Value::Text(e.to_lowercase()));
        }
        if let Some(e) = &f.to_email {
            // The index narrows to messages with these words among the recipients; the JSON
            // check then keeps exact matches. Scanning every message's JSON is slow on a big mailbox.
            wh.push("m.pk IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)".into());
            args.push(Value::Text(format!("{{recipients}}: \"{}\"", e.replace('"', ""))));
            wh.push(
                "(EXISTS (SELECT 1 FROM json_each(m.to_json) j WHERE lower(json_extract(j.value, '$.email')) = ?)
                  OR EXISTS (SELECT 1 FROM json_each(m.cc_json) j WHERE lower(json_extract(j.value, '$.email')) = ?))"
                    .into(),
            );
            args.push(Value::Text(e.to_lowercase()));
            args.push(Value::Text(e.to_lowercase()));
        }
        if let Some(d) = &f.received_after {
            wh.push("m.received_at >= ?".into());
            args.push(Value::Text(d.clone()));
        }
        if !wh.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&wh.join(" AND "));
        }
        if paged {
            sql.push_str(" ORDER BY m.received_at DESC LIMIT ?");
            args.push(Value::Integer(if f.limit > 0 { f.limit } else { 200 }));
        }
        (sql, args)
    }

    pub fn get_message(&self, raw_id: &str) -> Result<StoredMessage> {
        let row = self
            .conn
            .query_row(
                &format!("SELECT {MSG_COLS}, m.cc_json, m.bcc_json, m.reply_to_json, m.body_html, m.internet_message_id, m.meeting_json FROM messages m WHERE m.id = ?1"),
                [raw_id],
                |r| {
                    let s = self.row_summary(r)?;
                    let body: Option<String> = r.get(16)?;
                    Ok((s, r.get::<_, String>(13)?, r.get::<_, String>(14)?, r.get::<_, String>(15)?, body, r.get::<_, Option<String>>(17)?, r.get::<_, Option<String>>(18)?))
                },
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("message {raw_id}")))?;
        let (summary, cc, bcc, reply_to, body, imid, meeting_json) = row;
        let meeting = meeting_json.and_then(|j| serde_json::from_str::<MeetingInfo>(&j).ok()).map(|mut m| {
            m.event_id = m.event_id.map(|e| ids::join(&self.account_id, &e));
            m
        });
        let raw_folder_id = ids::split(&summary.folder_id)?.1.to_string();
        let attachments = self.list_attachments(raw_id)?;
        Ok(StoredMessage {
            raw_id: raw_id.to_string(),
            raw_folder_id,
            has_body: body.is_some(),
            internet_message_id: imid,
            message: Message {
                cc: from_json(Some(cc)),
                bcc: from_json(Some(bcc)),
                reply_to: from_json(Some(reply_to)),
                body_html: body.unwrap_or_default(),
                remote_images_blocked: false,
                attachments,
                summary,
                meeting,
            },
        })
    }

    /// The stored row as a record, for merging partial delta items onto it.
    pub fn get_message_record(&self, raw_id: &str) -> Result<Option<MessageRecord>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, folder_id, conversation_id, internet_message_id, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
                        subject, snippet, body_html, received_at, is_read, is_flagged, has_attachments, is_draft, web_link, meeting_type
                 FROM messages WHERE id = ?1",
                [raw_id],
                |r| {
                    Ok(MessageRecord {
                        id: r.get(0)?,
                        folder_id: r.get(1)?,
                        conversation_id: r.get(2)?,
                        internet_message_id: r.get(3)?,
                        from: Address { name: r.get(4)?, email: r.get(5)? },
                        to: from_json(r.get(6)?),
                        cc: from_json(r.get(7)?),
                        bcc: from_json(r.get(8)?),
                        reply_to: from_json(r.get(9)?),
                        subject: r.get(10)?,
                        snippet: r.get(11)?,
                        body_html: r.get(12)?,
                        received_at: r.get(13)?,
                        is_read: r.get(14)?,
                        is_flagged: r.get(15)?,
                        has_attachments: r.get(16)?,
                        is_draft: r.get(17)?,
                        web_link: r.get(18)?,
                        meeting_type: r.get(19)?,
                    })
                },
            )
            .optional()?)
    }

    /// Graph's type for the message (None = not known yet) and whether its meeting details are stored.
    pub fn meeting_state(&self, raw_id: &str) -> Result<(Option<String>, bool)> {
        Ok(self
            .conn
            .query_row("SELECT meeting_type, meeting_json IS NOT NULL FROM messages WHERE id = ?1", [raw_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .unwrap_or((Some(String::new()), false)))
    }

    pub fn set_meeting_type(&self, raw_id: &str, meeting_type: &str) -> Result<()> {
        self.conn.execute("UPDATE messages SET meeting_type = ?2 WHERE id = ?1", params![raw_id, meeting_type])?;
        Ok(())
    }

    /// Store a meeting message's details (`event_id` raw).
    pub fn set_meeting(&self, raw_id: &str, meeting: &MeetingInfo) -> Result<()> {
        self.conn.execute("UPDATE messages SET meeting_json = ?2 WHERE id = ?1", params![raw_id, to_json(meeting)])?;
        Ok(())
    }

    pub fn has_event(&self, raw_id: &str) -> Result<bool> {
        Ok(self.conn.query_row("SELECT 1 FROM events WHERE id = ?1", [raw_id], |_| Ok(())).optional()?.is_some())
    }

    pub fn message_exists(&self, raw_id: &str) -> Result<bool> {
        Ok(self.conn.query_row("SELECT 1 FROM messages WHERE id = ?1", [raw_id], |_| Ok(())).optional()?.is_some())
    }

    pub fn conversation_message_ids(&self, conversation_id: &str) -> Result<Vec<String>> {
        let mut st = self.conn.prepare("SELECT id FROM messages WHERE conversation_id = ?1 AND is_draft = 0 ORDER BY received_at DESC")?;
        let rows = st.query_map([conversation_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    pub fn set_read(&self, raw_id: &str, read: bool) -> Result<()> {
        self.conn.execute("UPDATE messages SET is_read = ?2 WHERE id = ?1", params![raw_id, read])?;
        Ok(())
    }

    pub fn set_flag(&self, raw_id: &str, flagged: bool) -> Result<()> {
        self.conn.execute("UPDATE messages SET is_flagged = ?2 WHERE id = ?1", params![raw_id, flagged])?;
        Ok(())
    }

    pub fn move_message(&self, raw_id: &str, raw_folder_id: &str) -> Result<()> {
        self.conn.execute("UPDATE messages SET folder_id = ?2 WHERE id = ?1", params![raw_id, raw_folder_id])?;
        Ok(())
    }

    /// Graph gives moved messages new ids (unless immutable ids are on, which we use) — kept for safety.
    pub fn rename_message(&self, old: &str, new: &str) -> Result<()> {
        self.conn.execute("UPDATE messages SET id = ?2 WHERE id = ?1", params![old, new])?;
        self.conn.execute("UPDATE attachments SET message_id = ?2 WHERE message_id = ?1", params![old, new])?;
        Ok(())
    }

    /// People in headers, for the people index: (address, received_at, outgoing).
    pub fn header_people(&self, me: &str) -> Result<Vec<(Address, String, bool)>> {
        let mut out = vec![];
        let sent = self.folder_id_by_role(FolderRole::Sent)?.unwrap_or_default();
        let mut st = self.conn.prepare("SELECT from_name, from_email, received_at FROM messages WHERE is_draft = 0 AND from_email != ?1 AND from_email != ''")?;
        for row in st.query_map([me.to_lowercase()], |r| Ok((Address { name: r.get(0)?, email: r.get(1)? }, r.get::<_, String>(2)?)))? {
            let (a, at) = row?;
            out.push((a, at, false));
        }
        let mut st = self.conn.prepare(
            "SELECT json_extract(j.value, '$.name'), lower(json_extract(j.value, '$.email')), m.received_at
             FROM messages m, json_each(m.to_json) j WHERE m.folder_id = ?1 OR m.from_email = ?2
             UNION ALL
             SELECT json_extract(j.value, '$.name'), lower(json_extract(j.value, '$.email')), m.received_at
             FROM messages m, json_each(m.cc_json) j WHERE m.folder_id = ?1 OR m.from_email = ?2",
        )?;
        for row in st.query_map(params![sent, me.to_lowercase()], |r| {
            Ok((Address { name: r.get::<_, Option<String>>(0)?.unwrap_or_default(), email: r.get::<_, Option<String>>(1)?.unwrap_or_default() }, r.get::<_, String>(2)?))
        })? {
            let (a, at) = row?;
            if !a.email.is_empty() && !a.email.eq_ignore_ascii_case(me) {
                out.push((a, at, true));
            }
        }
        Ok(out)
    }

    // ---------------------------------------------------------------- attachments

    pub fn replace_attachments(&self, raw_message_id: &str, list: &[Attachment]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let cached: Vec<(String, Option<String>)> = tx
            .prepare("SELECT id, local_path FROM attachments WHERE message_id = ?1")?
            .query_map([raw_message_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        tx.execute("DELETE FROM attachments WHERE message_id = ?1", [raw_message_id])?;
        for a in list {
            let local = a.local_path.clone().or_else(|| cached.iter().find(|(id, _)| *id == a.id).and_then(|(_, p)| p.clone()));
            tx.execute(
                "INSERT INTO attachments (message_id, id, name, content_type, size, is_inline, content_id, local_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![raw_message_id, a.id, a.name, a.content_type, a.size, a.is_inline, a.content_id, local],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_attachments(&self, raw_message_id: &str) -> Result<Vec<Attachment>> {
        let mut st = self.conn.prepare("SELECT id, name, content_type, size, is_inline, content_id, local_path FROM attachments WHERE message_id = ?1 ORDER BY name")?;
        let rows = st
            .query_map([raw_message_id], |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    content_type: r.get(2)?,
                    size: r.get(3)?,
                    is_inline: r.get(4)?,
                    content_id: r.get(5)?,
                    local_path: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn attachments_checked(&self, raw_message_id: &str) -> Result<bool> {
        Ok(self.conn.query_row("SELECT attachments_checked FROM messages WHERE id = ?1", [raw_message_id], |r| r.get::<_, bool>(0)).optional()?.unwrap_or(false))
    }

    pub fn set_attachments_checked(&self, raw_message_id: &str) -> Result<()> {
        self.conn.execute("UPDATE messages SET attachments_checked = 1 WHERE id = ?1", [raw_message_id])?;
        Ok(())
    }

    /// Messages received since `since` whose attachment list hasn't been fetched yet, newest first.
    pub fn messages_needing_attachment_list(&self, since: &str, limit: i64) -> Result<Vec<String>> {
        let mut st = self.conn.prepare(
            "SELECT id FROM messages
             WHERE received_at >= ?1 AND attachments_checked = 0 AND is_draft = 0
               AND (has_attachments = 1 OR body_html LIKE '%cid:%')
             ORDER BY received_at DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![since, limit], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Attachments of messages received since `since` that aren't cached yet, newest first:
    /// (message id, attachment id, size).
    pub fn attachments_to_download(&self, since: &str, limit: i64) -> Result<Vec<(String, String, i64)>> {
        let mut st = self.conn.prepare(
            "SELECT a.message_id, a.id, a.size FROM attachments a JOIN messages m ON m.id = a.message_id
             WHERE m.received_at >= ?1 AND a.local_path IS NULL AND a.download_failed = 0
             ORDER BY m.received_at DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![since, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Cached files of messages received since `since`.
    pub fn cached_attachment_paths_since(&self, since: &str) -> Result<Vec<String>> {
        let mut st = self.conn.prepare(
            "SELECT a.local_path FROM attachments a JOIN messages m ON m.id = a.message_id
             WHERE m.received_at >= ?1 AND a.local_path IS NOT NULL",
        )?;
        let rows = st.query_map([since], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Forget cached files that were deleted from disk.
    pub fn clear_attachment_paths(&self, paths: &[String]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for p in paths {
            tx.execute("UPDATE attachments SET local_path = NULL WHERE local_path = ?1", [p])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_attachment_failed(&self, raw_message_id: &str, attachment_id: &str) -> Result<()> {
        self.conn.execute("UPDATE attachments SET download_failed = 1 WHERE message_id = ?1 AND id = ?2", params![raw_message_id, attachment_id])?;
        Ok(())
    }

    pub fn has_attachment_rows(&self, raw_message_id: &str) -> Result<bool> {
        Ok(self.conn.query_row("SELECT 1 FROM attachments WHERE message_id = ?1 LIMIT 1", [raw_message_id], |_| Ok(())).optional()?.is_some())
    }

    pub fn set_attachment_path(&self, raw_message_id: &str, attachment_id: &str, path: &str) -> Result<()> {
        self.conn.execute("UPDATE attachments SET local_path = ?3 WHERE message_id = ?1 AND id = ?2", params![raw_message_id, attachment_id, path])?;
        Ok(())
    }

    // ---------------------------------------------------------------- drafts

    fn row_draft(&self, r: &Row) -> rusqlite::Result<(Draft, Option<String>)> {
        Ok((
            Draft {
                id: self.pid(&r.get::<_, String>(0)?),
                account_id: self.account_id.clone(),
                mode: DraftMode::parse(&r.get::<_, String>(2)?),
                source_message_id: r.get::<_, Option<String>>(3)?.map(|s| self.pid(&s)),
                conversation_id: r.get(4)?,
                to: from_json(r.get(5)?),
                cc: from_json(r.get(6)?),
                bcc: from_json(r.get(7)?),
                subject: r.get(8)?,
                body_html: r.get(9)?,
                signature_id: r.get(10)?,
                attachments: from_json(r.get(11)?),
                updated_at: r.get(12)?,
                saved_to_server: r.get(13)?,
                status: DraftStatus::parse(&r.get::<_, String>(14)?),
                error: r.get(15)?,
                popped_out: r.get(16)?,
                edited: r.get(17)?,
            },
            r.get(1)?,
        ))
    }

    const DRAFT_COLS: &'static str =
        "id, server_id, mode, source_message_id, conversation_id, to_json, cc_json, bcc_json, subject, body_html, signature_id, attachments_json, updated_at, saved_to_server, status, error, popped_out, edited";

    /// Insert or replace a draft. `raw_source` is the raw id of the message replied to.
    pub fn save_draft(&self, raw_id: &str, d: &Draft, raw_source: Option<&str>, created_by: &str) -> Result<()> {
        self.conn.execute(
            &format!(
                "INSERT INTO drafts ({}, created_by) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                 ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json,
                   subject = excluded.subject, body_html = excluded.body_html, signature_id = excluded.signature_id, attachments_json = excluded.attachments_json,
                   updated_at = excluded.updated_at, saved_to_server = excluded.saved_to_server, status = excluded.status, error = excluded.error,
                   popped_out = excluded.popped_out, edited = excluded.edited",
                Self::DRAFT_COLS
            ),
            params![
                raw_id,
                d.mode.as_str(),
                raw_source,
                d.conversation_id,
                to_json(&d.to),
                to_json(&d.cc),
                to_json(&d.bcc),
                d.subject,
                d.body_html,
                d.signature_id,
                to_json(&d.attachments),
                d.updated_at,
                d.saved_to_server,
                d.status.as_str(),
                d.error,
                d.popped_out,
                d.edited,
                created_by
            ],
        )?;
        Ok(())
    }

    pub fn get_draft(&self, raw_id: &str) -> Result<(Draft, Option<String>)> {
        self.conn
            .query_row(&format!("SELECT {} FROM drafts WHERE id = ?1", Self::DRAFT_COLS), [raw_id], |r| self.row_draft(r))
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("draft {raw_id}")))
    }

    pub fn draft_by_server_id(&self, server_id: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT id FROM drafts WHERE server_id = ?1", [server_id], |r| r.get(0)).optional()?)
    }

    pub fn drafts_for_conversation(&self, conversation_id: &str) -> Result<Vec<Draft>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {} FROM drafts WHERE conversation_id = ?1 AND status IN ('editing', 'failed', 'unknown') ORDER BY updated_at DESC",
            Self::DRAFT_COLS
        ))?;
        let rows = st.query_map([conversation_id], |r| self.row_draft(r).map(|x| x.0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn list_drafts(&self) -> Result<Vec<Draft>> {
        let mut st = self.conn.prepare(&format!("SELECT {} FROM drafts WHERE status != 'sent' ORDER BY updated_at DESC", Self::DRAFT_COLS))?;
        let rows = st.query_map([], |r| self.row_draft(r).map(|x| x.0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// The Drafts folder: local drafts (by draft id) and server drafts not linked to one.
    pub fn draft_summaries(&self, me: &Address, limit: i64) -> Result<Vec<MessageSummary>> {
        let folder = self.folder_id_by_role(FolderRole::Drafts)?.unwrap_or_default();
        let mut out: Vec<MessageSummary> = self
            .list_drafts()?
            .into_iter()
            .map(|d| MessageSummary {
                id: d.id.clone(),
                account_id: self.account_id.clone(),
                folder_id: self.pid(&folder),
                conversation_id: d.conversation_id.clone().unwrap_or_else(|| d.id.clone()),
                from: me.clone(),
                to: d.to.clone(),
                subject: d.subject.clone(),
                snippet: crate::text::snippet(&crate::text::html_to_text(&strip_signature_and_quote(&d.body_html)), 200),
                received_at: d.updated_at.clone(),
                is_read: true,
                is_flagged: false,
                has_attachments: !d.attachments.is_empty(),
                is_draft: true,
                has_draft: false,
            })
            .collect();
        let mut st = self.conn.prepare(&format!(
            "SELECT {MSG_COLS} FROM messages m WHERE m.folder_id = ?1 AND m.id NOT IN (SELECT server_id FROM drafts WHERE server_id IS NOT NULL) ORDER BY m.received_at DESC LIMIT ?2"
        ))?;
        let rows = st.query_map(params![folder, limit], |r| self.row_summary(r))?.collect::<rusqlite::Result<Vec<_>>>()?;
        out.extend(rows.into_iter().map(|mut m| {
            m.is_draft = true;
            m
        }));
        out.sort_by(|a, b| b.received_at.cmp(&a.received_at));
        out.truncate(limit.max(1) as usize);
        Ok(out)
    }

    pub fn set_draft_quote(&self, raw_id: &str, quote: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE drafts SET quote_html = ?2 WHERE id = ?1", params![raw_id, quote])?;
        Ok(())
    }

    pub fn draft_quote(&self, raw_id: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT quote_html FROM drafts WHERE id = ?1", [raw_id], |r| r.get(0)).optional()?.flatten())
    }

    pub fn set_draft_server_id(&self, raw_id: &str, server_id: &str) -> Result<()> {
        self.conn.execute("UPDATE drafts SET server_id = ?2, saved_to_server = 1 WHERE id = ?1", params![raw_id, server_id])?;
        Ok(())
    }

    pub fn set_draft_saved(&self, raw_id: &str, saved: bool) -> Result<()> {
        self.conn.execute("UPDATE drafts SET saved_to_server = ?2 WHERE id = ?1", params![raw_id, saved])?;
        Ok(())
    }

    pub fn set_draft_status(&self, raw_id: &str, status: DraftStatus, error: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE drafts SET status = ?2, error = ?3 WHERE id = ?1", params![raw_id, status.as_str(), error])?;
        Ok(())
    }

    pub fn delete_draft(&self, raw_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM drafts WHERE id = ?1", [raw_id])?;
        Ok(())
    }

    pub fn count_held_sends(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM drafts WHERE status = 'unknown'", [], |r| r.get(0))?)
    }

    // ---------------------------------------------------------------- pending operations

    pub fn enqueue(&self, kind: &str, payload: &serde_json::Value) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO pending_ops (kind, payload, next_attempt_at, created_at) VALUES (?1, ?2, ?3, ?3)",
            params![kind, payload.to_string(), now_iso()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    fn row_op(r: &Row) -> rusqlite::Result<PendingOp> {
        Ok(PendingOp {
            id: r.get(0)?,
            kind: r.get(1)?,
            payload: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(serde_json::Value::Null),
            state: r.get(3)?,
            attempts: r.get(4)?,
            last_error: r.get(5)?,
        })
    }

    /// Operations ready to run, oldest first. Held operations wait for the user.
    pub fn due_ops(&self, now: &str) -> Result<Vec<PendingOp>> {
        let mut st = self.conn.prepare(
            "SELECT id, kind, payload, state, attempts, last_error FROM pending_ops WHERE state = 'pending' AND next_attempt_at <= ?1 ORDER BY id",
        )?;
        let rows = st.query_map([now], Self::row_op)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn all_ops(&self) -> Result<Vec<PendingOp>> {
        let mut st = self.conn.prepare("SELECT id, kind, payload, state, attempts, last_error FROM pending_ops ORDER BY id")?;
        let rows = st.query_map([], Self::row_op)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn op_done(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM pending_ops WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn op_retry_later(&self, id: i64, next_at: &str, err: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE pending_ops SET attempts = attempts + 1, next_attempt_at = ?2, last_error = ?3 WHERE id = ?1",
            params![id, next_at, err],
        )?;
        Ok(())
    }

    pub fn op_set_state(&self, id: i64, state: &str, err: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE pending_ops SET state = ?2, last_error = COALESCE(?3, last_error) WHERE id = ?1", params![id, state, err])?;
        Ok(())
    }

    pub fn ops_for_draft(&self, raw_draft_id: &str) -> Result<Vec<PendingOp>> {
        Ok(self.all_ops()?.into_iter().filter(|o| o.payload.get("draftId").and_then(|v| v.as_str()) == Some(raw_draft_id)).collect())
    }

    // ---------------------------------------------------------------- calendars & events

    pub fn upsert_calendar(&self, id: &str, name: &str, is_default: bool, can_edit: bool) -> Result<()> {
        self.conn.execute(
            "INSERT INTO calendars (id, name, is_default, can_edit) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default, can_edit = excluded.can_edit",
            params![id, name, is_default, can_edit],
        )?;
        Ok(())
    }

    /// (raw id, name, is_default, can_edit)
    pub fn list_calendars(&self) -> Result<Vec<(String, String, bool, bool)>> {
        let mut st = self.conn.prepare("SELECT id, name, is_default, can_edit FROM calendars ORDER BY is_default DESC, name")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Whether events in this calendar may be changed here (unknown calendars: yes).
    pub fn calendar_can_edit(&self, raw_id: &str) -> Result<bool> {
        Ok(self.conn.query_row("SELECT can_edit FROM calendars WHERE id = ?1", [raw_id], |r| r.get(0)).optional()?.unwrap_or(true))
    }

    /// Delete a calendar and all its events.
    pub fn delete_calendar(&self, raw_id: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM events WHERE calendar_id = ?1", [raw_id])?;
        tx.execute("DELETE FROM calendars WHERE id = ?1", [raw_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Replace a calendar's events in [start, end) with `events`, in one transaction, and prune
    /// events that end at or before `start`. Events after `end` are kept. Returns whether the
    /// stored events changed.
    pub fn replace_events_in_range(&self, raw_calendar_id: &str, start: &str, end: &str, events: &[EventRecord]) -> Result<bool> {
        // Overlaps [start, end); a zero-length event counts when it sits inside the range.
        const IN_RANGE: &str = "calendar_id = ?1 AND start_at < ?3 AND (end_at > ?2 OR start_at >= ?2)";
        let tx = self.conn.unchecked_transaction()?;
        let old_ids: Vec<String> = tx.prepare(&format!("SELECT id FROM events WHERE {IN_RANGE} ORDER BY id"))?.query_map(params![raw_calendar_id, start, end], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        let mut old = vec![];
        for id in &old_ids {
            old.extend(self.get_event_record(id)?);
        }
        let mut new: Vec<&EventRecord> = events.iter().collect();
        new.sort_by(|a, b| a.id.cmp(&b.id));
        let mut changed = old.len() != new.len() || old.iter().zip(&new).any(|(a, b)| a != *b);
        tx.execute(&format!("DELETE FROM events WHERE {IN_RANGE}"), params![raw_calendar_id, start, end])?;
        for e in events {
            self.upsert_event(e)?;
        }
        changed |= tx.execute("DELETE FROM events WHERE calendar_id = ?1 AND end_at <= ?2 AND start_at < ?2", params![raw_calendar_id, start])? > 0;
        tx.commit()?;
        Ok(changed)
    }

    pub fn default_calendar(&self) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT id FROM calendars ORDER BY is_default DESC LIMIT 1", [], |r| r.get(0)).optional()?)
    }

    pub fn upsert_event(&self, e: &EventRecord) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO events (id, calendar_id, subject, start_at, end_at, is_all_day, location, body_html, organizer_json, attendees_json,
                                            my_response, is_online_meeting, online_meeting_url, reminder_minutes, is_cancelled, local_only)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                e.id,
                e.calendar_id,
                e.subject,
                e.start,
                e.end,
                e.is_all_day,
                e.location,
                e.body_html,
                to_json(&e.organizer),
                to_json(&e.attendees),
                serde_json::to_value(e.my_response).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "none".into()),
                e.is_online_meeting,
                e.online_meeting_url,
                e.reminder_minutes,
                e.is_cancelled,
                e.local_only
            ],
        )?;
        Ok(())
    }

    /// The stored row for an event, as written by `upsert_event`.
    pub fn get_event_record(&self, raw_id: &str) -> Result<Option<EventRecord>> {
        Ok(self
            .conn
            .query_row(&format!("SELECT {}, local_only FROM events WHERE id = ?1", Self::EVENT_COLS), [raw_id], |r| {
                let resp: String = r.get(10)?;
                Ok(EventRecord {
                    id: r.get(0)?,
                    calendar_id: r.get(1)?,
                    subject: r.get(2)?,
                    start: r.get(3)?,
                    end: r.get(4)?,
                    is_all_day: r.get(5)?,
                    location: r.get(6)?,
                    body_html: r.get(7)?,
                    organizer: from_json(r.get(8)?),
                    attendees: from_json(r.get(9)?),
                    my_response: serde_json::from_value(serde_json::Value::String(resp)).unwrap_or_default(),
                    is_online_meeting: r.get(11)?,
                    online_meeting_url: r.get(12)?,
                    reminder_minutes: r.get(13)?,
                    is_cancelled: r.get(14)?,
                    local_only: r.get(15)?,
                })
            })
            .optional()?)
    }

    pub fn delete_event(&self, raw_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM events WHERE id = ?1", [raw_id])?;
        Ok(())
    }

    pub fn rename_event(&self, old: &str, new: &str) -> Result<()> {
        self.conn.execute("UPDATE events SET id = ?2, local_only = 0 WHERE id = ?1", params![old, new])?;
        Ok(())
    }

    /// Remove events in a window that the server no longer returns.
    pub fn retain_events_in_range(&self, raw_calendar_id: &str, start: &str, end: &str, keep: &[String]) -> Result<()> {
        let ids: Vec<String> = self
            .conn
            .prepare("SELECT id FROM events WHERE calendar_id = ?1 AND local_only = 0 AND end_at > ?2 AND start_at < ?3")?
            .query_map(params![raw_calendar_id, start, end], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for id in ids.into_iter().filter(|id| !keep.contains(id)) {
            self.delete_event(&id)?;
        }
        Ok(())
    }

    fn row_event(&self, r: &Row, color: &str) -> rusqlite::Result<CalendarEvent> {
        let resp: String = r.get(10)?;
        Ok(CalendarEvent {
            id: self.pid(&r.get::<_, String>(0)?),
            account_id: self.account_id.clone(),
            calendar_id: self.pid(&r.get::<_, String>(1)?),
            subject: r.get(2)?,
            start: r.get(3)?,
            end: r.get(4)?,
            is_all_day: r.get(5)?,
            location: r.get(6)?,
            body_html: r.get(7)?,
            organizer: from_json(r.get(8)?),
            attendees: from_json(r.get(9)?),
            my_response: serde_json::from_value(serde_json::Value::String(resp)).unwrap_or_default(),
            is_online_meeting: r.get(11)?,
            online_meeting_url: r.get(12)?,
            reminder_minutes: r.get(13)?,
            is_cancelled: r.get(14)?,
            color: color.to_string(),
            read_only: !r.get::<_, bool>(15)?,
        })
    }

    /// Stored event columns, in the order `get_event_record` and `row_event` read them (indices 0..=14).
    const EVENT_COLS: &'static str = event_cols!();

    /// EVENT_COLS plus whether the event's calendar can be edited (index 15). Every query mapped
    /// with `row_event` must select exactly these.
    const EVENT_VIEW_COLS: &'static str =
        concat!(event_cols!(), ", COALESCE((SELECT c.can_edit FROM calendars c WHERE c.id = events.calendar_id), 1)");

    /// Events overlapping [start, end).
    pub fn list_events(&self, start: &str, end: &str, color: &str) -> Result<Vec<CalendarEvent>> {
        let mut st = self.conn.prepare(&format!("SELECT {} FROM events WHERE end_at > ?1 AND start_at < ?2 ORDER BY start_at", Self::EVENT_VIEW_COLS))?;
        let rows = st.query_map([start, end], |r| self.row_event(r, color))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Events matching every word of the query in its field, within its date range; latest first.
    /// `after` and `before` are normalised UTC times.
    pub fn search_events(&self, q: &EventQuery, after: Option<&str>, before: Option<&str>, color: &str) -> Result<Vec<CalendarEvent>> {
        let words: Vec<String> = q.text.split_whitespace().map(|w| format!("%{}%", w.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))).collect();
        if words.is_empty() && after.is_none() && before.is_none() {
            return Ok(vec![]);
        }
        // Names and addresses only, not the JSON keys around them.
        let people = "coalesce(json_extract(organizer_json, '$.name'), '') || ' ' || coalesce(json_extract(organizer_json, '$.email'), '') || ' '
            || coalesce((SELECT group_concat(coalesce(json_extract(j.value, '$.address.name'), '') || ' ' || coalesce(json_extract(j.value, '$.address.email'), ''), ' ') FROM json_each(attendees_json) j), '')";
        let hay = match q.field {
            EventField::Title => "subject".to_string(),
            EventField::People => format!("({people})"),
            EventField::All => format!("(subject || ' ' || location || ' ' || {people} || ' ' || body_html)"),
        };
        let mut wh = vec!["is_cancelled = 0".to_string()];
        let mut args: Vec<String> = vec![];
        for w in words {
            wh.push(format!("{hay} LIKE ? ESCAPE '\\'"));
            args.push(w);
        }
        if let Some(a) = after {
            wh.push("end_at > ?".into());
            args.push(a.to_string());
        }
        if let Some(b) = before {
            wh.push("start_at < ?".into());
            args.push(b.to_string());
        }
        let limit = q.limit.unwrap_or(200).clamp(1, 500);
        let sql = format!("SELECT {} FROM events WHERE {} ORDER BY start_at DESC LIMIT {limit}", Self::EVENT_VIEW_COLS, wh.join(" AND "));
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params_from_iter(args), |r| self.row_event(r, color))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_event(&self, raw_id: &str, color: &str) -> Result<CalendarEvent> {
        self.conn
            .query_row(&format!("SELECT {} FROM events WHERE id = ?1", Self::EVENT_VIEW_COLS), [raw_id], |r| self.row_event(r, color))
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("event {raw_id}")))
    }

    pub fn set_event_response(&self, raw_id: &str, response: ResponseStatus) -> Result<()> {
        let v = serde_json::to_value(response)?.as_str().unwrap_or("none").to_string();
        self.conn.execute("UPDATE events SET my_response = ?2 WHERE id = ?1", params![raw_id, v])?;
        Ok(())
    }

    pub fn now() -> String {
        now_iso()
    }
}

fn strip_signature_and_quote(body: &str) -> String {
    let cut = [body.find("<div data-signature"), body.find("<div data-quote")].into_iter().flatten().min();
    match cut {
        Some(i) => body[..i].to_string(),
        None => body.to_string(),
    }
}

/// Build an FTS5 query from free text: every word must match as a prefix.
/// An FTS5 query for the search text: every word as a prefix, all required, limited to the
/// columns for `field`.
pub fn fts_query(text: &str, field: SearchField) -> Option<String> {
    let terms = fts_terms(text)?;
    let cols = match field {
        SearchField::All => return Some(terms),
        SearchField::From => "sender",
        SearchField::To => "recipients",
        SearchField::Subject => "subject",
        SearchField::Content => "subject body",
    };
    Some(format!("{{{cols}}}: ({terms})"))
}

fn fts_terms(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '(' || c == ')' || c == '*' || c == ':' || c == '^')
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn db() -> AccountDb {
        AccountDb::new(crate::db::open_memory().unwrap(), "acc1").unwrap()
    }

    fn msg(id: &str, folder: &str, subject: &str, from: &str, at: &str) -> MessageRecord {
        MessageRecord {
            id: id.into(),
            folder_id: folder.into(),
            conversation_id: format!("c-{subject}"),
            from: Address::new(from, format!("{}@x.com", from.to_lowercase())),
            to: vec![Address::new("Miles", "miles@me.com")],
            subject: subject.into(),
            snippet: "snippet".into(),
            body_html: Some(format!("<p>Body about {subject}</p>")),
            received_at: at.into(),
            ..Default::default()
        }
    }

    #[test]
    fn meeting_details_round_trip() {
        let db = db();
        db.upsert_folder("inbox1", "Inbox", Some(FolderRole::Inbox), None, 1).unwrap();
        let mut m = msg("m1", "inbox1", "Project Clarity", "Maurice", "2026-11-25T16:44:00Z");
        db.upsert_message(&m).unwrap();
        assert_eq!(db.meeting_state("m1").unwrap(), (None, false), "older rows are unknown");
        m.meeting_type = Some("eventMessageRequest".into());
        db.upsert_message(&m).unwrap();
        // An update that doesn't say keeps the type.
        m.meeting_type = None;
        db.upsert_message(&m).unwrap();
        assert_eq!(db.meeting_state("m1").unwrap(), (Some("eventMessageRequest".into()), false));

        let info = MeetingInfo {
            kind: MeetingKind::Request,
            start: "2026-11-26T13:00:00Z".into(),
            end: "2026-11-26T13:30:00Z".into(),
            is_all_day: false,
            location: "Microsoft Teams Meeting".into(),
            event_id: Some("ev1".into()),
            event: None,
        };
        db.set_meeting("m1", &info).unwrap();
        assert!(db.meeting_state("m1").unwrap().1);
        let got = db.get_message("m1").unwrap().message.meeting.unwrap();
        assert_eq!(got.event_id.as_deref(), Some("acc1:ev1"), "public event ID");
        assert_eq!(got.start, info.start);
    }

    #[test]
    fn messages_and_search() {
        let db = db();
        db.upsert_folder("inbox1", "Inbox", Some(FolderRole::Inbox), None, 2).unwrap();
        db.upsert_folder("arch1", "Archive", Some(FolderRole::Archive), None, 0).unwrap();
        db.upsert_message(&msg("m1", "inbox1", "Steering committee", "Sarah", "2026-11-23T09:42:00Z")).unwrap();
        db.upsert_message(&msg("m2", "inbox1", "Invoice", "Tom", "2026-11-23T09:15:00Z")).unwrap();

        let all = db.list_messages(&MessageFilter { folder_ids: vec!["inbox1".into()], ..Default::default() }).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "acc1:m1");
        assert_eq!(db.list_folders().unwrap()[0].unread, 2);

        let hits = db.list_messages(&MessageFilter { fts: fts_query("steer", SearchField::All), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);
        let hits = db.list_messages(&MessageFilter { fts: fts_query("body", SearchField::All), from_email: Some("TOM@x.com".into()), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].subject, "Invoice");
        let to = db.list_messages(&MessageFilter { to_email: Some("miles@me.com".into()), ..Default::default() }).unwrap();
        assert_eq!(to.len(), 2);

        db.set_read("m1", true).unwrap();
        db.move_message("m1", "arch1").unwrap();
        assert_eq!(db.list_folders().unwrap()[0].unread, 1);
        // Header-only update keeps the body.
        let mut h = msg("m2", "inbox1", "Invoice", "Tom", "2026-11-23T09:15:00Z");
        h.body_html = None;
        db.upsert_message(&h).unwrap();
        assert!(db.get_message("m2").unwrap().has_body);
        // Index follows updates and deletes.
        db.delete_message("m2").unwrap();
        assert_eq!(db.list_messages(&MessageFilter { fts: fts_query("invoice", SearchField::All), ..Default::default() }).unwrap().len(), 0);
    }

    #[test]
    fn search_by_field() {
        let db = db();
        db.upsert_folder("inbox1", "Inbox", Some(FolderRole::Inbox), None, 2).unwrap();
        // From Sarah to Miles, and from Tom to Miles with Sarah in the subject.
        db.upsert_message(&msg("m1", "inbox1", "Steering committee", "Sarah", "2026-11-23T09:42:00Z")).unwrap();
        db.upsert_message(&msg("m2", "inbox1", "Ask Sarah", "Tom", "2026-11-23T09:15:00Z")).unwrap();
        let find = |text: &str, field| {
            let f = MessageFilter { fts: fts_query(text, field), limit: 10, ..Default::default() };
            let (list, total) = db.list_messages_counted(&f).unwrap();
            assert_eq!(list.len() as i64, total);
            list.into_iter().map(|m| m.id).collect::<Vec<_>>()
        };
        assert_eq!(find("sar", SearchField::From), vec!["acc1:m1"]);
        assert_eq!(find("sarah@x", SearchField::From), vec!["acc1:m1"]);
        assert_eq!(find("sarah", SearchField::Subject), vec!["acc1:m2"]);
        assert_eq!(find("sarah", SearchField::All), vec!["acc1:m1", "acc1:m2"]);
        assert_eq!(find("miles", SearchField::To).len(), 2);
        assert!(find("miles", SearchField::From).is_empty());
        assert_eq!(find("body about steering", SearchField::Content), vec!["acc1:m1"]);
        assert!(find("nobody", SearchField::All).is_empty());
    }

    #[test]
    fn index_rebuilt_with_sender_and_recipients() {
        // A database from before the sender/recipients split.
        let conn = crate::db::open_memory().unwrap();
        crate::db::migrate(&conn, &MIGRATIONS[..5]).unwrap();
        conn.execute_batch(
            r#"INSERT INTO messages (pk, id, folder_id, conversation_id, from_name, from_email, to_json, cc_json, subject, received_at)
                 VALUES (1, 'm1', 'inbox1', 'c1', 'Jane Doe', 'jane@acme.com', '[{"name":"Bob Ray","email":"bob@x.com"}]', '[]', 'Hello', '2026-11-23T09:00:00Z');
               INSERT INTO messages_fts (rowid, subject, body, people) VALUES (1, 'Hello', 'the body text', 'Jane Doe jane@acme.com Bob Ray bob@x.com');"#,
        )
        .unwrap();
        let db = AccountDb::new(conn, "acc1").unwrap();
        let find = |text: &str, field| db.list_messages(&MessageFilter { fts: fts_query(text, field), ..Default::default() }).unwrap().len();
        assert_eq!(find("jane", SearchField::From), 1);
        assert_eq!(find("bob", SearchField::From), 0);
        assert_eq!(find("bob", SearchField::To), 1);
        assert_eq!(find("body", SearchField::Content), 1);
    }

    #[test]
    fn fts_query_is_safe() {
        assert_eq!(fts_query("  ", SearchField::All), None);
        assert_eq!(fts_query("steer \"com", SearchField::All), Some("\"steer\"* \"com\"*".into()));
        assert_eq!(fts_query("a:b OR (c)", SearchField::All), Some("\"a\"* \"b\"* \"OR\"* \"c\"*".into()));
        assert_eq!(fts_query("jane d", SearchField::From), Some("{sender}: (\"jane\"* \"d\"*)".into()));
        assert_eq!(fts_query("x", SearchField::Content), Some("{subject body}: (\"x\"*)".into()));
    }

    #[test]
    fn ops_queue() {
        let db = db();
        let id = db.enqueue("markRead", &serde_json::json!({"ids": ["m1"], "read": true})).unwrap();
        assert_eq!(db.due_ops(&now_iso()).unwrap().len(), 1);
        db.op_retry_later(id, "2999-01-01T00:00:00Z", "offline").unwrap();
        assert!(db.due_ops(&now_iso()).unwrap().is_empty());
        db.op_done(id).unwrap();
        assert!(db.all_ops().unwrap().is_empty());
    }
}
