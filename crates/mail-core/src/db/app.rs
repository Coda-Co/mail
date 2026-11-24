//! App database: accounts, settings, signatures, calendar visibility.

use super::{from_json, migrate, now_iso, to_json};
use crate::error::{Error, Result};
use crate::ids;
use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension, Row};

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  color TEXT NOT NULL,
  notifications INTEGER NOT NULL DEFAULT 1,
  agents_enabled INTEGER NOT NULL DEFAULT 0,
  offline_months INTEGER NOT NULL DEFAULT 6,
  tenant_id TEXT,
  home_account_id TEXT,
  web_url TEXT,
  web_unread INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'idle',
  sync_error TEXT,
  last_synced_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE signatures (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  html TEXT NOT NULL,
  default_new INTEGER NOT NULL DEFAULT 0,
  default_reply INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE calendar_visibility (calendar_id TEXT PRIMARY KEY, visible INTEGER NOT NULL);
"#];

pub const PALETTE: [&str; 6] = ["#1F883D", "#8250DF", "#D4600F", "#0B5CC4", "#BF3989", "#1A7F8E"];
pub const WEB_COLOR: &str = "#6E7781";

pub struct AppDb {
    pub conn: Connection,
}

const ACCOUNT_COLS: &str = "id, email, display_name, kind, color, notifications, agents_enabled, offline_months, tenant_id, web_url, web_unread, sync_state, sync_error, last_synced_at";

fn row_account(r: &Row) -> rusqlite::Result<Account> {
    let kind = AccountKind::parse(&r.get::<_, String>(3)?);
    Ok(Account {
        id: r.get(0)?,
        email: r.get(1)?,
        display_name: r.get(2)?,
        kind,
        color: r.get(4)?,
        // Graph unread counts are filled in by the service from the account database.
        unread: if kind == AccountKind::Web { r.get(10)? } else { None },
        notifications: r.get(5)?,
        agents_enabled: r.get(6)?,
        offline_months: r.get(7)?,
        tenant_id: r.get(8)?,
        web_url: r.get(9)?,
        sync_state: SyncState::parse(&r.get::<_, String>(11)?),
        sync_error: r.get(12)?,
        last_synced_at: r.get(13)?,
    })
}

#[derive(Debug, Clone)]
pub struct NewAccount {
    pub email: String,
    pub display_name: String,
    pub kind: AccountKind,
    pub tenant_id: Option<String>,
    pub home_account_id: Option<String>,
    pub web_url: Option<String>,
}

impl AppDb {
    pub fn new(conn: Connection) -> Result<Self> {
        migrate(&conn, MIGRATIONS)?;
        Ok(AppDb { conn })
    }

    // ---- accounts

    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        let mut st = self.conn.prepare(&format!("SELECT {ACCOUNT_COLS} FROM accounts ORDER BY sort_order, created_at"))?;
        let rows = st.query_map([], row_account)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_account(&self, id: &str) -> Result<Account> {
        self.conn
            .query_row(&format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE id = ?1"), [id], row_account)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("account {id}")))
    }

    pub fn find_account_by_email(&self, email: &str) -> Result<Option<Account>> {
        Ok(self
            .conn
            .query_row(&format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE lower(email) = lower(?1)"), [email], row_account)
            .optional()?)
    }

    pub fn home_account_id(&self, id: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT home_account_id FROM accounts WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten())
    }

    fn next_color(&self) -> Result<String> {
        let used: Vec<String> = self
            .conn
            .prepare("SELECT color FROM accounts WHERE kind = 'graph'")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(PALETTE
            .iter()
            .find(|c| !used.iter().any(|u| u.eq_ignore_ascii_case(c)))
            .unwrap_or(&PALETTE[used.len() % PALETTE.len()])
            .to_string())
    }

    pub fn insert_account(&self, a: NewAccount) -> Result<Account> {
        let id = ids::new_account_id();
        let color = match a.kind {
            AccountKind::Web => WEB_COLOR.to_string(),
            AccountKind::Graph => self.next_color()?,
        };
        let order: i64 = self.conn.query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO accounts (id, email, display_name, kind, color, tenant_id, home_account_id, web_url, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, a.email, a.display_name, a.kind.as_str(), color, a.tenant_id, a.home_account_id, a.web_url, order, now_iso()],
        )?;
        self.get_account(&id)
    }

    /// Upgrade a web account to Graph once its tenant has consented. Keeps id and order.
    pub fn convert_to_graph(&self, id: &str, tenant_id: Option<String>, home_account_id: Option<String>) -> Result<Account> {
        let color = self.next_color()?;
        self.conn.execute(
            "UPDATE accounts SET kind = 'graph', color = ?2, tenant_id = ?3, home_account_id = ?4, web_unread = NULL WHERE id = ?1",
            params![id, color, tenant_id, home_account_id],
        )?;
        self.get_account(id)
    }

    pub fn update_account(&self, id: &str, p: &AccountPatch) -> Result<Account> {
        let a = self.get_account(id)?;
        self.conn.execute(
            "UPDATE accounts SET display_name = ?2, color = ?3, notifications = ?4, agents_enabled = ?5, offline_months = ?6 WHERE id = ?1",
            params![
                id,
                p.display_name.clone().unwrap_or(a.display_name),
                p.color.clone().unwrap_or(a.color),
                p.notifications.unwrap_or(a.notifications),
                p.agents_enabled.unwrap_or(a.agents_enabled),
                p.offline_months.unwrap_or(a.offline_months).clamp(1, 120),
            ],
        )?;
        self.get_account(id)
    }

    pub fn set_sync_state(&self, id: &str, state: SyncState, error: Option<&str>) -> Result<()> {
        let synced = if state == SyncState::Idle { Some(now_iso()) } else { None };
        self.conn.execute(
            "UPDATE accounts SET sync_state = ?2, sync_error = ?3, last_synced_at = COALESCE(?4, last_synced_at) WHERE id = ?1",
            params![id, state.as_str(), error, synced],
        )?;
        Ok(())
    }

    pub fn set_web_unread(&self, id: &str, unread: Option<i64>) -> Result<bool> {
        let old: Option<i64> = self.conn.query_row("SELECT web_unread FROM accounts WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten();
        self.conn.execute("UPDATE accounts SET web_unread = ?2 WHERE id = ?1", params![id, unread])?;
        Ok(old != unread)
    }

    pub fn delete_account(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        self.conn.execute("DELETE FROM calendar_visibility WHERE calendar_id LIKE ?1", [format!("{id}:%")])?;
        Ok(())
    }

    // ---- settings

    pub fn settings(&self) -> Result<Settings> {
        let raw: Option<String> = self.conn.query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0)).optional()?;
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
    }

    pub fn update_settings(&self, p: &SettingsPatch) -> Result<Settings> {
        let mut s = self.settings()?;
        if let Some(v) = &p.theme {
            if !["light", "dark", "system"].contains(&v.as_str()) {
                return Err(Error::Invalid(format!("theme {v}")));
            }
            s.theme = v.clone();
        }
        if let Some(v) = p.notifications {
            s.notifications = v;
        }
        if let Some(v) = &p.ctrl_f {
            if !["forward", "find"].contains(&v.as_str()) {
                return Err(Error::Invalid(format!("ctrlF {v}")));
            }
            s.ctrl_f = v.clone();
        }
        if let Some(v) = p.mcp_enabled {
            s.mcp_enabled = v;
        }
        // Sending by agents stays off in v1 whatever is asked.
        if p.mcp_allow_send.is_some() {
            s.mcp_allow_send = false;
        }
        if let Some(v) = &p.remote_image_senders {
            s.remote_image_senders = v.iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect();
            s.remote_image_senders.sort();
            s.remote_image_senders.dedup();
        }
        if let Some(v) = &p.remote_images {
            if !["show", "ask"].contains(&v.as_str()) {
                return Err(Error::Invalid(format!("remoteImages {v}")));
            }
            s.remote_images = v.clone();
        }
        if let Some(v) = p.conversation_view {
            s.conversation_view = v;
        }
        self.conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ?1)", [to_json(&s)])?;
        Ok(s)
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", [key, value])?;
        Ok(())
    }

    // ---- signatures

    pub fn list_signatures(&self, account_id: Option<&str>) -> Result<Vec<Signature>> {
        let mut st = self.conn.prepare(
            "SELECT id, account_id, name, html, default_new, default_reply FROM signatures
             WHERE ?1 IS NULL OR account_id = ?1 ORDER BY account_id, name",
        )?;
        let rows = st
            .query_map([account_id], |r| {
                Ok(Signature {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    name: r.get(2)?,
                    html: r.get(3)?,
                    default_new: r.get(4)?,
                    default_reply: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_signature(&self, id: &str) -> Result<Option<Signature>> {
        Ok(self.list_signatures(None)?.into_iter().find(|s| s.id == id))
    }

    pub fn save_signature(&self, sig: &Signature) -> Result<Signature> {
        self.get_account(&sig.account_id)?;
        let mut sig = sig.clone();
        if sig.id.is_empty() {
            sig.id = ids::new_local_id("sig");
        }
        sig.html = crate::html::sanitize_signature(&sig.html);
        let tx = self.conn.unchecked_transaction()?;
        // Only one default of each kind per account.
        if sig.default_new {
            tx.execute("UPDATE signatures SET default_new = 0 WHERE account_id = ?1", [&sig.account_id])?;
        }
        if sig.default_reply {
            tx.execute("UPDATE signatures SET default_reply = 0 WHERE account_id = ?1", [&sig.account_id])?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO signatures (id, account_id, name, html, default_new, default_reply) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![sig.id, sig.account_id, sig.name, sig.html, sig.default_new, sig.default_reply],
        )?;
        tx.commit()?;
        Ok(sig)
    }

    pub fn delete_signature(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM signatures WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn default_signature(&self, account_id: &str, for_reply: bool) -> Result<Option<Signature>> {
        let sigs = self.list_signatures(Some(account_id))?;
        Ok(sigs.into_iter().find(|s| if for_reply { s.default_reply } else { s.default_new }))
    }

    // ---- calendar visibility (public calendar ids)

    pub fn calendar_visible(&self, calendar_id: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT visible FROM calendar_visibility WHERE calendar_id = ?1", [calendar_id], |r| r.get(0))
            .optional()?
            .unwrap_or(true))
    }

    pub fn set_calendar_visible(&self, calendar_id: &str, visible: bool) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO calendar_visibility (calendar_id, visible) VALUES (?1, ?2)", params![calendar_id, visible])?;
        Ok(())
    }

    pub fn raw_json<T: serde::de::DeserializeOwned + Default>(&self, key: &str) -> Result<T> {
        Ok(from_json(self.kv_get(key)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> AppDb {
        AppDb::new(crate::db::open_memory().unwrap()).unwrap()
    }

    fn graph(db: &AppDb, email: &str) -> Account {
        db.insert_account(NewAccount { email: email.into(), display_name: email.into(), kind: AccountKind::Graph, tenant_id: None, home_account_id: None, web_url: None })
            .unwrap()
    }

    #[test]
    fn colours_assigned_from_palette() {
        let db = db();
        let a = graph(&db, "a@x.com");
        let b = graph(&db, "b@y.com");
        let w = db
            .insert_account(NewAccount { email: "c@z.com".into(), display_name: "Z".into(), kind: AccountKind::Web, tenant_id: None, home_account_id: None, web_url: None })
            .unwrap();
        assert_eq!(a.color, PALETTE[0]);
        assert_eq!(b.color, PALETTE[1]);
        assert_eq!(w.color, WEB_COLOR);
        let up = db.convert_to_graph(&w.id, Some("tid".into()), None).unwrap();
        assert_eq!(up.kind, AccountKind::Graph);
        assert_eq!(up.color, PALETTE[2]);
        assert_eq!(db.list_accounts().unwrap().len(), 3);
    }

    #[test]
    fn one_default_signature_per_kind() {
        let db = db();
        let a = graph(&db, "a@x.com");
        let s1 = db.save_signature(&Signature { id: String::new(), account_id: a.id.clone(), name: "Full".into(), html: "<b>Miles</b>".into(), default_new: true, default_reply: true }).unwrap();
        let s2 = db.save_signature(&Signature { id: String::new(), account_id: a.id.clone(), name: "Short".into(), html: "M".into(), default_new: false, default_reply: true }).unwrap();
        assert_eq!(db.default_signature(&a.id, false).unwrap().unwrap().id, s1.id);
        assert_eq!(db.default_signature(&a.id, true).unwrap().unwrap().id, s2.id);
    }

    #[test]
    fn agents_cannot_be_allowed_to_send() {
        let db = db();
        let s = db.update_settings(&SettingsPatch { mcp_enabled: Some(true), mcp_allow_send: Some(true), ..Default::default() }).unwrap();
        assert!(s.mcp_enabled);
        assert!(!s.mcp_allow_send);
        assert!(db.update_settings(&SettingsPatch { theme: Some("neon".into()), ..Default::default() }).is_err());
    }
}
