//! mail-mcp: a local MCP server (stdio) giving AI agents read and write access to
//! mail and calendar for the Graph accounts enabled for agents in Settings.
//!
//! Off by default. Agents can create and update drafts but never send: I send.
//! Writes go to the local store and the outbox queue; the app syncs them to Microsoft 365.

use anyhow::Result;
use mail_core::model::*;
use mail_core::text::html_to_text;
use mail_core::{ids, MailService};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

const PROTOCOL: &str = "2025-06-18";
pub const APP_IDENTIFIER: &str = "co.coda.mail";

fn main() -> Result<()> {
    let mut data_dir: Option<PathBuf> = std::env::var_os("MAIL_APP_DATA").map(PathBuf::from);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--data-dir" => data_dir = args.next().map(PathBuf::from),
            "--help" | "-h" => {
                eprintln!("mail-mcp [--data-dir <path>]\nLocal MCP server for the mail app (stdio).");
                return Ok(());
            }
            other => eprintln!("mail-mcp: ignoring argument {other}"),
        }
    }
    let dir = data_dir.or_else(|| dirs::data_dir().map(|d| d.join(APP_IDENTIFIER))).ok_or_else(|| anyhow::anyhow!("no data directory; pass --data-dir"))?;
    let svc = MailService::open(&dir)?;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) => handle(&svc, &req),
            Err(e) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}})),
        };
        if let Some(r) = reply {
            writeln!(out, "{}", serde_json::to_string(&r)?)?;
            out.flush()?;
        }
    }
    Ok(())
}

/// Handle one JSON-RPC message. Notifications get no reply.
pub fn handle(svc: &MailService, req: &Value) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    let id = id?; // notifications (no id): nothing to answer
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(|v| v.as_str()).filter(|v| *v <= PROTOCOL).unwrap_or(PROTOCOL),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "mail-app", "title": "Mail", "version": env!("CARGO_PKG_VERSION")},
            "instructions": "Read and search my mail and calendar, and draft replies. You cannot send mail: create a draft and tell me it is ready. Only accounts I have enabled for agents are visible."
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(match call(svc, name, &args) {
                Ok(v) => json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default()}], "structuredContent": v, "isError": false}),
                Err(e) => json!({"content": [{"type": "text", "text": e}], "isError": true}),
            })
        }
        _ => Err(json!({"code": -32601, "message": format!("method not found: {method}")})),
    };
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": e}),
    })
}

fn tools() -> Value {
    let addr_list = json!({"type": "array", "items": {"type": "string"}, "description": "Email addresses, or \"Name <address>\""});
    json!([
        {
            "name": "search_mail",
            "title": "Search mail",
            "description": "Search messages in the local store (offline window). Returns newest first.",
            "inputSchema": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Words to match in subject, body or people"},
                "from": {"type": "string", "description": "Sender email address"},
                "to": {"type": "string", "description": "Recipient email address"},
                "unread": {"type": "boolean"},
                "has_attachment": {"type": "boolean"},
                "account": {"type": "string", "description": "Account id or email (default: all enabled accounts)"},
                "folder": {"type": "string", "enum": ["inbox", "sent", "drafts", "archive", "all"], "default": "all"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}
            }},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "read_message",
            "title": "Read message",
            "description": "Read one message as plain text, with its attachments listed.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "read_thread",
            "title": "Read conversation",
            "description": "Read every message in a message's conversation, newest first, plus any drafts.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string", "description": "Any message id in the conversation"}}, "required": ["id"]},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "list_events",
            "title": "List calendar events",
            "description": "Events across enabled accounts' calendars. Defaults to the next 7 days.",
            "inputSchema": {"type": "object", "properties": {
                "start": {"type": "string", "description": "ISO 8601 date or date-time"},
                "end": {"type": "string", "description": "ISO 8601 date or date-time"}
            }},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "create_draft",
            "title": "Create draft",
            "description": "Create a draft (new, or a reply/forward to a message). It is saved to the account's Drafts folder. It is NOT sent: the user reviews and sends it.",
            "inputSchema": {"type": "object", "properties": {
                "reply_to": {"type": "string", "description": "Message id to reply to"},
                "mode": {"type": "string", "enum": ["reply", "replyAll", "forward"], "default": "reply"},
                "account": {"type": "string", "description": "Account id or email for a new message (replies use the account the message came in on)"},
                "to": addr_list, "cc": addr_list, "bcc": addr_list,
                "subject": {"type": "string"},
                "body": {"type": "string", "description": "Plain text. Blank lines separate paragraphs. The signature is added automatically."}
            }},
            "annotations": {"readOnlyHint": false, "destructiveHint": false}
        },
        {
            "name": "update_draft",
            "title": "Update draft",
            "description": "Change a draft's recipients, subject or body. Fields left out are unchanged. Drafts being sent cannot be changed.",
            "inputSchema": {"type": "object", "properties": {
                "id": {"type": "string"},
                "to": addr_list, "cc": addr_list, "bcc": addr_list,
                "subject": {"type": "string"},
                "body": {"type": "string", "description": "Plain text; replaces the text above the signature."}
            }, "required": ["id"]},
            "annotations": {"readOnlyHint": false, "destructiveHint": false}
        },
        {
            "name": "create_event",
            "title": "Create event",
            "description": "Create a calendar event. Invitations go to attendees when the app next syncs.",
            "inputSchema": {"type": "object", "properties": {
                "account": {"type": "string"},
                "subject": {"type": "string"},
                "start": {"type": "string", "description": "ISO 8601 date-time"},
                "end": {"type": "string", "description": "ISO 8601 date-time"},
                "all_day": {"type": "boolean"},
                "location": {"type": "string"},
                "attendees": addr_list,
                "body": {"type": "string"},
                "online_meeting": {"type": "boolean", "description": "Add a Teams meeting"}
            }, "required": ["account", "subject", "start", "end"]},
            "annotations": {"readOnlyHint": false, "destructiveHint": false}
        }
    ])
}

type R<T> = std::result::Result<T, String>;

fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

fn enabled_accounts(svc: &MailService) -> R<Vec<Account>> {
    let settings = svc.settings().map_err(e)?;
    if !settings.mcp_enabled {
        return Err("Agent access is off. Turn it on in the mail app: Settings → Agents.".into());
    }
    let list: Vec<Account> = svc.graph_accounts().map_err(e)?.into_iter().filter(|a| a.agents_enabled).collect();
    if list.is_empty() {
        return Err("No accounts are enabled for agents. Enable one in Settings → Accounts.".into());
    }
    Ok(list)
}

fn check_id(accounts: &[Account], id: &str) -> R<()> {
    let (acc, _) = ids::split(id).map_err(e)?;
    if accounts.iter().any(|a| a.id == acc) {
        Ok(())
    } else {
        Err(format!("{id} is not in an account enabled for agents"))
    }
}

fn find_account<'a>(accounts: &'a [Account], key: &str) -> R<&'a Account> {
    accounts
        .iter()
        .find(|a| a.id == key || a.email.eq_ignore_ascii_case(key) || a.display_name.eq_ignore_ascii_case(key))
        .ok_or_else(|| format!("No enabled account matches {key}"))
}

fn str_arg<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty())
}

fn parse_addresses(args: &Value, k: &str) -> R<Option<Vec<Address>>> {
    let Some(v) = args.get(k) else { return Ok(None) };
    let items: Vec<String> = match v {
        Value::String(s) => s.split([',', ';']).map(|x| x.to_string()).collect(),
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        Value::Null => vec![],
        _ => return Err(format!("{k} must be a list of addresses")),
    };
    let mut out = vec![];
    for raw in items {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let (name, email) = match (raw.find('<'), raw.rfind('>')) {
            (Some(l), Some(r)) if r > l => (raw[..l].trim().trim_matches('"').to_string(), raw[l + 1..r].trim().to_string()),
            _ => (String::new(), raw.to_string()),
        };
        if !mail_core::service::valid_email(&email) {
            return Err(format!("{email} isn't a valid address"));
        }
        out.push(Address { name, email });
    }
    Ok(Some(out))
}

fn summary_json(svc: &MailService, m: &MessageSummary) -> Value {
    let account = svc.get_account(&m.account_id).map(|a| a.display_name).unwrap_or_default();
    json!({
        "id": m.id, "account": account, "from": format!("{} <{}>", m.from.name, m.from.email),
        "to": m.to.iter().map(|a| a.email.clone()).collect::<Vec<_>>(),
        "subject": m.subject, "date": m.received_at, "snippet": m.snippet, "unread": !m.is_read,
        "hasAttachments": m.has_attachments, "conversationId": m.conversation_id
    })
}

fn message_json(m: &Message) -> Value {
    json!({
        "id": m.summary.id,
        "from": format!("{} <{}>", m.summary.from.name, m.summary.from.email),
        "to": m.summary.to.iter().map(|a| format!("{} <{}>", a.name, a.email)).collect::<Vec<_>>(),
        "cc": m.cc.iter().map(|a| format!("{} <{}>", a.name, a.email)).collect::<Vec<_>>(),
        "subject": m.summary.subject,
        "date": m.summary.received_at,
        "body": html_to_text(&m.body_html),
        "attachments": m.attachments.iter().map(|a| json!({"name": a.name, "size": a.size, "contentType": a.content_type})).collect::<Vec<_>>()
    })
}

fn draft_json(d: &Draft) -> Value {
    json!({
        "id": d.id, "status": d.status, "to": d.to, "cc": d.cc, "bcc": d.bcc, "subject": d.subject,
        "body": html_to_text(&d.body_html), "note": "Draft saved. It will not be sent until the user sends it."
    })
}

/// Put agent text above the signature and quote, replacing whatever was typed there.
fn with_body(existing: &str, text: &str) -> String {
    let cut = [existing.find("<div data-signature"), existing.find("<div data-quote")].into_iter().flatten().min().unwrap_or(existing.len());
    format!("<div>{}</div>{}", mail_core::text::text_to_html(text), &existing[cut..])
}

pub fn call(svc: &MailService, name: &str, args: &Value) -> R<Value> {
    let accounts = enabled_accounts(svc)?;
    match name {
        "search_mail" => {
            let folder = str_arg(args, "folder").unwrap_or("all");
            let account = match str_arg(args, "account") {
                Some(k) => Some(find_account(&accounts, k)?.id.clone()),
                None => None,
            };
            let role = FolderRole::parse(folder);
            let q = SearchQuery {
                text: str_arg(args, "query").unwrap_or("").to_string(),
                scope: ViewScope { account_id: None, folder: FolderSelector::Role { role: role.unwrap_or(FolderRole::Inbox) }, tab: ListTab::All },
                all_folders: role.is_none(),
                from: str_arg(args, "from").map(String::from),
                to: str_arg(args, "to").map(String::from),
                has_attachment: args.get("has_attachment").and_then(|v| v.as_bool()),
                unread: args.get("unread").and_then(|v| v.as_bool()),
                date: None,
                account_id: account,
            };
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).clamp(1, 100) as usize;
            let r = svc.search(&q).map_err(e)?;
            let msgs: Vec<Value> = r.messages.iter().filter(|m| accounts.iter().any(|a| a.id == m.account_id)).take(limit).map(|m| summary_json(svc, m)).collect();
            Ok(json!({"count": msgs.len(), "messages": msgs}))
        }
        "read_message" => {
            let id = str_arg(args, "id").ok_or("id is required")?;
            check_id(&accounts, id)?;
            Ok(message_json(&svc.get_message(id).map_err(e)?))
        }
        "read_thread" => {
            let id = str_arg(args, "id").ok_or("id is required")?;
            check_id(&accounts, id)?;
            let t = svc.get_thread(id).map_err(e)?;
            Ok(json!({"subject": t.subject, "messages": t.messages.iter().map(message_json).collect::<Vec<_>>(), "drafts": t.drafts.iter().map(draft_json).collect::<Vec<_>>()}))
        }
        "list_events" => {
            let now = chrono::Local::now();
            let start = str_arg(args, "start").map(String::from).unwrap_or_else(|| now.date_naive().to_string());
            let end = str_arg(args, "end").map(String::from).unwrap_or_else(|| (now.date_naive() + chrono::Duration::days(7)).to_string());
            let list = svc.list_events(&start, &end).map_err(e)?;
            let events: Vec<Value> = list
                .iter()
                .filter(|ev| accounts.iter().any(|a| a.id == ev.account_id))
                .map(|ev| {
                    json!({
                        "id": ev.id, "account": accounts.iter().find(|a| a.id == ev.account_id).map(|a| a.display_name.clone()),
                        "subject": ev.subject, "start": ev.start, "end": ev.end, "allDay": ev.is_all_day, "location": ev.location,
                        "organizer": ev.organizer.email, "myResponse": ev.my_response,
                        "attendees": ev.attendees.iter().map(|a| a.address.email.clone()).collect::<Vec<_>>()
                    })
                })
                .collect();
            Ok(json!({"count": events.len(), "events": events}))
        }
        "create_draft" => {
            let (mode, source, account) = match str_arg(args, "reply_to") {
                Some(src) => {
                    check_id(&accounts, src)?;
                    let mode = match str_arg(args, "mode").unwrap_or("reply") {
                        "replyAll" => DraftMode::ReplyAll,
                        "forward" => DraftMode::Forward,
                        _ => DraftMode::Reply,
                    };
                    (mode, Some(src.to_string()), None)
                }
                None => {
                    let acc = match str_arg(args, "account") {
                        Some(k) => find_account(&accounts, k)?.id.clone(),
                        None => accounts[0].id.clone(),
                    };
                    (DraftMode::New, None, Some(acc))
                }
            };
            let mut d = svc.create_draft_by(&CreateDraftRequest { mode, source_message_id: source, account_id: account }, "agent").map_err(e)?;
            apply_edits(&mut d, args)?;
            let d = svc.update_draft(&d).map_err(e)?;
            Ok(draft_json(&d))
        }
        "update_draft" => {
            let id = str_arg(args, "id").ok_or("id is required")?;
            check_id(&accounts, id)?;
            let mut d = svc.get_draft(id).map_err(e)?;
            apply_edits(&mut d, args)?;
            let d = svc.update_draft(&d).map_err(e)?;
            Ok(draft_json(&d))
        }
        "create_event" => {
            let acc = find_account(&accounts, str_arg(args, "account").ok_or("account is required")?)?;
            let input = EventInput {
                account_id: acc.id.clone(),
                calendar_id: None,
                subject: str_arg(args, "subject").ok_or("subject is required")?.to_string(),
                start: str_arg(args, "start").ok_or("start is required")?.to_string(),
                end: str_arg(args, "end").ok_or("end is required")?.to_string(),
                is_all_day: args.get("all_day").and_then(|v| v.as_bool()).unwrap_or(false),
                location: str_arg(args, "location").unwrap_or("").to_string(),
                body_html: str_arg(args, "body").map(mail_core::text::text_to_html).unwrap_or_default(),
                attendees: parse_addresses(args, "attendees")?.unwrap_or_default(),
                is_online_meeting: args.get("online_meeting").and_then(|v| v.as_bool()).unwrap_or(false),
                reminder_minutes: None,
            };
            let ev = svc.create_event(&input).map_err(e)?;
            Ok(json!({"id": ev.id, "subject": ev.subject, "start": ev.start, "end": ev.end, "note": "Created. Invitations are sent when the app next syncs."}))
        }
        "send_mail" | "send_draft" => Err("Sending is never automatic. The draft is ready for the user to review and send.".into()),
        other => Err(format!("unknown tool {other}")),
    }
}

fn apply_edits(d: &mut Draft, args: &Value) -> R<()> {
    if let Some(v) = parse_addresses(args, "to")? {
        d.to = v;
    }
    if let Some(v) = parse_addresses(args, "cc")? {
        d.cc = v;
    }
    if let Some(v) = parse_addresses(args, "bcc")? {
        d.bcc = v;
    }
    if let Some(s) = args.get("subject").and_then(|v| v.as_str()) {
        d.subject = s.to_string();
    }
    if let Some(b) = args.get("body").and_then(|v| v.as_str()) {
        d.body_html = with_body(&d.body_html, b);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};

    fn setup(enable: bool) -> (MailService, mail_core::demo::DemoIds) {
        let svc = MailService::in_memory().unwrap();
        let ids = mail_core::demo::seed_at(&svc, Local.with_ymd_and_hms(2026, 11, 23, 9, 50, 0).unwrap()).unwrap();
        if enable {
            svc.update_settings(&SettingsPatch { mcp_enabled: Some(true), ..Default::default() }).unwrap();
            for a in [&ids.coda, &ids.harbour] {
                svc.update_account(a, &AccountPatch { agents_enabled: Some(true), ..Default::default() }).unwrap();
            }
        }
        (svc, ids)
    }

    fn rpc(svc: &MailService, method: &str, params: Value) -> Value {
        handle(svc, &json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})).unwrap()
    }

    fn tool(svc: &MailService, name: &str, args: Value) -> Value {
        rpc(svc, "tools/call", json!({"name": name, "arguments": args}))["result"].clone()
    }

    #[test]
    fn handshake_and_listing() {
        let (svc, _) = setup(true);
        let init = rpc(&svc, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}));
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert!(handle(&svc, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).is_none());
        let names: Vec<String> = rpc(&svc, "tools/list", json!({}))["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, vec!["search_mail", "read_message", "read_thread", "list_events", "create_draft", "update_draft", "create_event"]);
        assert!(!names.iter().any(|n| n.contains("send")));
        assert_eq!(rpc(&svc, "nope", json!({}))["error"]["code"], -32601);
    }

    #[test]
    fn off_by_default() {
        let (svc, _) = setup(false);
        let r = tool(&svc, "search_mail", json!({"query": "steering"}));
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("Agent access is off"));
    }

    #[test]
    fn only_enabled_accounts_are_visible() {
        let (svc, ids) = setup(true);
        let r = tool(&svc, "search_mail", json!({"query": "access"}));
        assert_eq!(r["structuredContent"]["count"], 0, "Fenwick is not enabled for agents");
        let r = tool(&svc, "read_message", json!({"id": format!("{}:m-access", ids.fenwick)}));
        assert_eq!(r["isError"], true);
        let r = tool(&svc, "search_mail", json!({"query": "steering", "from": "sarah.okafor@harbourpartners.example"}));
        assert_eq!(r["structuredContent"]["count"], 3);
    }

    #[test]
    fn read_and_draft_reply_without_sending() {
        let (svc, ids) = setup(true);
        let src = format!("{}:m-agenda", ids.harbour);
        let m = tool(&svc, "read_message", json!({"id": src}));
        assert!(m["structuredContent"]["body"].as_str().unwrap().contains("AI roadmap item"));
        let t = tool(&svc, "read_thread", json!({"id": src}));
        assert_eq!(t["structuredContent"]["messages"].as_array().unwrap().len(), 1);

        let d = tool(&svc, "create_draft", json!({"reply_to": src, "body": "Hi Sarah,\n\nHappy to take it.\n\nMiles"}));
        assert_eq!(d["isError"], false, "{d}");
        let draft = &d["structuredContent"];
        assert_eq!(draft["status"], "editing");
        assert!(draft["body"].as_str().unwrap().starts_with("Hi Sarah,"));
        let id = draft["id"].as_str().unwrap();
        let stored = svc.get_draft(id).unwrap();
        assert_eq!(stored.body_html.matches("data-signature").count(), 1, "signature kept once");
        assert!(!stored.body_html.contains("data-quote"));

        let u = tool(&svc, "update_draft", json!({"id": id, "cc": ["James Hart <james.hart@harbourpartners.example>"], "body": "Updated text"}));
        assert_eq!(u["structuredContent"]["cc"][0]["name"], "James Hart");
        assert!(svc.get_draft(id).unwrap().body_html.starts_with("<div><p>Updated text</p></div>"));
        let bad = tool(&svc, "update_draft", json!({"id": id, "to": ["nope"]}));
        assert_eq!(bad["isError"], true);

        let send = tool(&svc, "send_draft", json!({"id": id}));
        assert_eq!(send["isError"], true);
        let ops: Vec<String> = svc.with_account(&ids.harbour, |db| Ok(db.all_ops()?.into_iter().map(|o| o.kind).collect())).unwrap();
        assert!(ops.contains(&"saveDraft".to_string()));
        assert!(!ops.contains(&"send".to_string()), "agents never queue a send");
    }

    #[test]
    fn new_draft_and_event() {
        let (svc, ids) = setup(true);
        let d = tool(&svc, "create_draft", json!({"account": "Coda & Co", "to": "tom@coda.example", "subject": "Invoice", "body": "Looks good."}));
        assert_eq!(d["isError"], false, "{d}");
        assert!(d["structuredContent"]["id"].as_str().unwrap().starts_with(&ids.coda));
        let ev = tool(&svc, "create_event", json!({"account": "miles@coda.example", "subject": "Invoice review", "start": "2026-11-24T14:00:00Z", "end": "2026-11-24T14:30:00Z", "attendees": ["tom@coda.example"]}));
        assert_eq!(ev["isError"], false, "{ev}");
        let list = tool(&svc, "list_events", json!({"start": "2026-11-24", "end": "2026-11-25"}));
        let subjects: Vec<&str> = list["structuredContent"]["events"].as_array().unwrap().iter().map(|e| e["subject"].as_str().unwrap()).collect();
        assert!(subjects.contains(&"Invoice review"));
        assert!(!subjects.contains(&"Warehouse design session"), "Fenwick hidden");
        let blocked = tool(&svc, "create_event", json!({"account": "Fenwick Group", "subject": "x", "start": "2026-11-24T14:00:00Z", "end": "2026-11-24T15:00:00Z"}));
        assert_eq!(blocked["isError"], true);
    }
}
