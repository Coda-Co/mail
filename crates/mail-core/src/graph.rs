//! Microsoft Graph client: requests with immutable ids, Retry-After handling and
//! token refresh, plus conversion of Graph JSON into stored records.

use crate::auth::Tokens;
use crate::db::account::{EventRecord, MessageRecord};
use crate::error::{Error, Result};
use crate::model::*;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";

pub const MESSAGE_SELECT: &str =
    "id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,isRead,flag,hasAttachments,isDraft,webLink,parentFolderId";
/// An event as the reading pane needs it, for a meeting message's expanded event.
pub const EVENT_SELECT: &str =
    "id,subject,start,end,isAllDay,location,body,organizer,attendees,responseStatus,isOrganizer,isOnlineMeeting,onlineMeeting,isReminderOn,reminderMinutesBeforeStart,isCancelled";
pub const HEADER_SELECT: &str =
    "id,conversationId,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,isRead,flag,hasAttachments,isDraft,webLink,parentFolderId";

#[derive(Clone)]
pub struct GraphClient {
    http: reqwest::Client,
    base: String,
    tokens: Arc<Tokens>,
    max_retries: u32,
    max_wait: Duration,
}

pub struct Response {
    pub status: StatusCode,
    pub body: Value,
}

impl GraphClient {
    pub fn new(http: reqwest::Client, base: impl Into<String>, tokens: Arc<Tokens>) -> Self {
        GraphClient { http, base: base.into().trim_end_matches('/').to_string(), tokens, max_retries: 4, max_wait: Duration::from_secs(120) }
    }

    pub fn http() -> reqwest::Client {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .user_agent("mail-app/0.1")
            .build()
            .expect("http client")
    }

    /// For tests: don't wait long on Retry-After.
    pub fn with_max_wait(mut self, d: Duration) -> Self {
        self.max_wait = d;
        self
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base, path)
        }
    }

    pub async fn request(&self, method: Method, path: &str, body: Option<&Value>, extra_prefer: &[&str]) -> Result<Response> {
        let url = self.url(path);
        let mut refreshed = false;
        let mut attempt = 0;
        loop {
            let token = self.tokens.access_token().await?;
            let mut prefer = vec!["IdType=\"ImmutableId\"", "outlook.body-content-type=\"html\"", "outlook.timezone=\"UTC\""];
            prefer.extend_from_slice(extra_prefer);
            let mut req = self.http.request(method.clone(), &url).bearer_auth(&token).header("Prefer", prefer.join(", "));
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send().await?;
            let status = resp.status();
            if status == StatusCode::UNAUTHORIZED && !refreshed {
                refreshed = true;
                self.tokens.invalidate().await;
                continue;
            }
            if (status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE || status == StatusCode::GATEWAY_TIMEOUT) && attempt < self.max_retries && method == Method::GET {
                let wait = retry_after(resp.headers()).unwrap_or(Duration::from_secs(2u64.pow(attempt + 1))).min(self.max_wait);
                attempt += 1;
                tokio::time::sleep(wait).await;
                continue;
            }
            if status == StatusCode::TOO_MANY_REQUESTS && attempt < self.max_retries {
                // Throttled before processing: safe to retry any method.
                let wait = retry_after(resp.headers()).unwrap_or(Duration::from_secs(2u64.pow(attempt + 1))).min(self.max_wait);
                attempt += 1;
                tokio::time::sleep(wait).await;
                continue;
            }
            let bytes = resp.bytes().await?;
            let body: Value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
            if status.is_success() {
                return Ok(Response { status, body });
            }
            let code = body.pointer("/error/code").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let message = body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or(status.canonical_reason().unwrap_or("")).to_string();
            if status == StatusCode::UNAUTHORIZED {
                return Err(Error::Auth(message));
            }
            return Err(Error::Graph { status: status.as_u16(), code, message });
        }
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        Ok(self.request(Method::GET, path, None, &[]).await?.body)
    }
    pub async fn get_paged(&self, path: &str, prefer: &[&str]) -> Result<Value> {
        Ok(self.request(Method::GET, path, None, prefer).await?.body)
    }
    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        Ok(self.request(Method::POST, path, Some(body), &[]).await?.body)
    }
    pub async fn patch(&self, path: &str, body: &Value) -> Result<Value> {
        Ok(self.request(Method::PATCH, path, Some(body), &[]).await?.body)
    }
    pub async fn delete(&self, path: &str) -> Result<()> {
        self.request(Method::DELETE, path, None, &[]).await.map(|_| ())
    }

    pub async fn get_bytes(&self, path: &str) -> Result<Vec<u8>> {
        let token = self.tokens.access_token().await?;
        let resp = self.http.get(self.url(path)).bearer_auth(token).header("Prefer", "IdType=\"ImmutableId\"").send().await?;
        if !resp.status().is_success() {
            return Err(Error::Graph { status: resp.status().as_u16(), code: String::new(), message: "download failed".into() });
        }
        Ok(resp.bytes().await?.to_vec())
    }

    /// Upload to an upload session URL (pre-authorised; no bearer token).
    pub async fn put_chunk(&self, url: &str, data: Vec<u8>, from: usize, total: usize) -> Result<Value> {
        let len = data.len();
        let resp = self
            .http
            .put(url)
            .header("Content-Length", len)
            .header("Content-Range", format!("bytes {}-{}/{}", from, from + len - 1, total))
            .body(data)
            .send()
            .await?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(Error::Graph { status: status.as_u16(), code: String::new(), message: "upload failed".into() });
        }
        Ok(body)
    }
}

fn retry_after(h: &reqwest::header::HeaderMap) -> Option<Duration> {
    h.get("Retry-After").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok()).map(Duration::from_secs)
}

pub fn quote(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

// ---------------------------------------------------------------- parsing

fn s(v: &Value, p: &str) -> String {
    v.pointer(p).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

pub fn address(v: &Value) -> Address {
    Address { name: s(v, "/emailAddress/name"), email: s(v, "/emailAddress/address").to_lowercase() }
}

fn addresses(v: &Value, key: &str) -> Vec<Address> {
    v.get(key).and_then(|a| a.as_array()).map(|a| a.iter().map(address).filter(|a| !a.email.is_empty()).collect()).unwrap_or_default()
}

/// Graph returns "2026-11-23T09:42:00Z" for messages and "2026-11-26T10:00:00.0000000" (+ timeZone) for events.
pub fn graph_time(v: &str) -> String {
    let t = v.trim();
    if t.is_empty() {
        return String::new();
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(t) {
        return d.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    }
    let base = t.split('.').next().unwrap_or(t);
    match chrono::NaiveDateTime::parse_from_str(base, "%Y-%m-%dT%H:%M:%S") {
        Ok(n) => n.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        Err(_) => t.to_string(),
    }
}

/// `with_body`: whether this message is inside the offline window (keep the body).
pub fn message_record(v: &Value, with_body: bool) -> MessageRecord {
    let body = if with_body && v.get("body").is_some() {
        let content = s(v, "/body/content");
        if s(v, "/body/contentType").eq_ignore_ascii_case("text") {
            Some(crate::text::text_to_html(&content))
        } else {
            Some(content)
        }
    } else {
        None
    };
    let preview = s(v, "/bodyPreview");
    MessageRecord {
        id: s(v, "/id"),
        folder_id: s(v, "/parentFolderId"),
        conversation_id: { let c = s(v, "/conversationId"); if c.is_empty() { s(v, "/id") } else { c } },
        internet_message_id: v.get("internetMessageId").and_then(|x| x.as_str()).map(String::from),
        from: v.get("from").map(address).unwrap_or_default(),
        to: addresses(v, "toRecipients"),
        cc: addresses(v, "ccRecipients"),
        bcc: addresses(v, "bccRecipients"),
        reply_to: addresses(v, "replyTo"),
        subject: s(v, "/subject"),
        snippet: crate::text::snippet(&preview, 200),
        body_html: body,
        received_at: graph_time(&s(v, "/receivedDateTime")),
        is_read: v.get("isRead").and_then(|x| x.as_bool()).unwrap_or(true),
        is_flagged: s(v, "/flag/flagStatus") == "flagged",
        has_attachments: v.get("hasAttachments").and_then(|x| x.as_bool()).unwrap_or(false),
        is_draft: v.get("isDraft").and_then(|x| x.as_bool()).unwrap_or(false),
        web_link: v.get("webLink").and_then(|x| x.as_str()).map(String::from),
        meeting_type: meeting_type(v),
    }
}

/// Graph's derived type for a message, e.g. "eventMessageRequest" for a meeting request;
/// Some("") for plain mail, None when the item doesn't say.
pub fn meeting_type(v: &Value) -> Option<String> {
    let t = v.get("@odata.type")?.as_str()?;
    let t = t.trim_start_matches('#').trim_start_matches("microsoft.graph.");
    Some(if t.starts_with("eventMessage") { t.to_string() } else { String::new() })
}

/// The event details of an eventMessage read with its event expanded. The event ID is raw.
pub fn meeting_info(v: &Value) -> MeetingInfo {
    let event = v.get("event").filter(|e| e.is_object());
    let pick = |msg_key: &str, ev_key: &str| {
        let m = s(v, &format!("/{msg_key}/dateTime"));
        graph_time(&if m.is_empty() { event.map(|e| s(e, &format!("/{ev_key}/dateTime"))).unwrap_or_default() } else { m })
    };
    let location = {
        let l = s(v, "/location/displayName");
        if l.is_empty() { event.map(|e| s(e, "/location/displayName")).unwrap_or_default() } else { l }
    };
    MeetingInfo {
        kind: MeetingKind::from_graph(&s(v, "/meetingMessageType"), &s(v, "/responseType")),
        start: pick("startDateTime", "start"),
        end: pick("endDateTime", "end"),
        is_all_day: v.get("isAllDay").or_else(|| event.and_then(|e| e.get("isAllDay"))).and_then(|x| x.as_bool()).unwrap_or(false),
        location,
        event_id: event.map(|e| s(e, "/id")).filter(|id| !id.is_empty()),
        event: None,
    }
}

/// True when a message delta item carries the full selected properties. Graph's message
/// delta sometimes sends only the id and the properties that changed (for new mail too).
pub fn is_full_message(v: &Value) -> bool {
    v.get("receivedDateTime").and_then(|x| x.as_str()).is_some_and(|s| !s.is_empty())
}

/// Builds a record from a (possibly partial) Graph message, keeping `base`'s value for
/// every property the item leaves out, so a change to one flag can't blank the rest.
pub fn message_record_over(v: &Value, with_body: bool, base: &MessageRecord) -> MessageRecord {
    let has = |k: &str| v.get(k).is_some();
    let n = message_record(v, with_body);
    let b = base.clone();
    MessageRecord {
        id: if n.id.is_empty() { b.id } else { n.id },
        folder_id: if n.folder_id.is_empty() { b.folder_id } else { n.folder_id },
        conversation_id: if has("conversationId") { n.conversation_id } else { b.conversation_id },
        internet_message_id: if has("internetMessageId") { n.internet_message_id } else { b.internet_message_id },
        from: if has("from") { n.from } else { b.from },
        to: if has("toRecipients") { n.to } else { b.to },
        cc: if has("ccRecipients") { n.cc } else { b.cc },
        bcc: if has("bccRecipients") { n.bcc } else { b.bcc },
        reply_to: if has("replyTo") { n.reply_to } else { b.reply_to },
        subject: if has("subject") { n.subject } else { b.subject },
        snippet: if has("bodyPreview") { n.snippet } else { b.snippet },
        body_html: n.body_html.or(b.body_html),
        received_at: if has("receivedDateTime") { n.received_at } else { b.received_at },
        is_read: if has("isRead") { n.is_read } else { b.is_read },
        is_flagged: if has("flag") { n.is_flagged } else { b.is_flagged },
        has_attachments: if has("hasAttachments") { n.has_attachments } else { b.has_attachments },
        is_draft: if has("isDraft") { n.is_draft } else { b.is_draft },
        web_link: if has("webLink") { n.web_link } else { b.web_link },
        meeting_type: n.meeting_type.or(b.meeting_type),
    }
}

pub fn event_record(v: &Value, calendar_id: &str) -> EventRecord {
    event_record_over(v, calendar_id, None)
}

/// Builds a record from a Graph event, keeping `base`'s value for every property the
/// item leaves out. calendarView/delta sends occurrences of a recurring series (and
/// some updates) with only id, type, start, end and seriesMasterId; overwriting the
/// stored row with those would blank the title and details.
pub fn event_record_over(v: &Value, calendar_id: &str, base: Option<&EventRecord>) -> EventRecord {
    let has = |k: &str| v.get(k).is_some();
    let Some(b) = base else { return event_record_full(v, calendar_id) };
    let n = event_record_full(v, calendar_id);
    EventRecord {
        id: if has("id") { n.id } else { b.id.clone() },
        calendar_id: n.calendar_id,
        subject: if has("subject") { n.subject } else { b.subject.clone() },
        start: if has("start") { n.start } else { b.start.clone() },
        end: if has("end") { n.end } else { b.end.clone() },
        is_all_day: if has("isAllDay") { n.is_all_day } else { b.is_all_day },
        location: if has("location") { n.location } else { b.location.clone() },
        body_html: if has("body") { n.body_html } else { b.body_html.clone() },
        organizer: if has("organizer") { n.organizer } else { b.organizer.clone() },
        attendees: if has("attendees") { n.attendees } else { b.attendees.clone() },
        my_response: if has("responseStatus") || has("isOrganizer") { n.my_response } else { b.my_response },
        is_online_meeting: if has("isOnlineMeeting") { n.is_online_meeting } else { b.is_online_meeting },
        online_meeting_url: if has("onlineMeeting") { n.online_meeting_url } else { b.online_meeting_url.clone() },
        reminder_minutes: if has("isReminderOn") || has("reminderMinutesBeforeStart") { n.reminder_minutes } else { b.reminder_minutes },
        is_cancelled: if has("isCancelled") { n.is_cancelled } else { b.is_cancelled },
        local_only: false,
    }
}

/// True for a recurring occurrence that arrived without its own details.
pub fn is_bare_occurrence(v: &Value) -> bool {
    v.get("subject").is_none() && v.get("seriesMasterId").and_then(|x| x.as_str()).is_some_and(|s| !s.is_empty())
}

fn event_record_full(v: &Value, calendar_id: &str) -> EventRecord {
    let attendees = v
        .get("attendees")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .map(|x| Attendee {
                    address: address(x),
                    kind: match s(x, "/type").as_str() {
                        "optional" => AttendeeType::Optional,
                        "resource" => AttendeeType::Resource,
                        _ => AttendeeType::Required,
                    },
                    response: ResponseStatus::from_graph(&s(x, "/status/response")),
                })
                .collect()
        })
        .unwrap_or_default();
    let reminder_on = v.get("isReminderOn").and_then(|x| x.as_bool()).unwrap_or(false);
    let join = s(v, "/onlineMeeting/joinUrl");
    EventRecord {
        id: s(v, "/id"),
        calendar_id: calendar_id.to_string(),
        subject: s(v, "/subject"),
        start: graph_time(&s(v, "/start/dateTime")),
        end: graph_time(&s(v, "/end/dateTime")),
        is_all_day: v.get("isAllDay").and_then(|x| x.as_bool()).unwrap_or(false),
        location: s(v, "/location/displayName"),
        body_html: s(v, "/body/content"),
        organizer: v.get("organizer").map(address).unwrap_or_default(),
        attendees,
        // Graph often says "none" for events you made with no invitees; isOrganizer is reliable.
        my_response: if v.get("isOrganizer").and_then(|x| x.as_bool()) == Some(true) {
            ResponseStatus::Organizer
        } else {
            ResponseStatus::from_graph(&s(v, "/responseStatus/response"))
        },
        is_online_meeting: v.get("isOnlineMeeting").and_then(|x| x.as_bool()).unwrap_or(false),
        online_meeting_url: if join.is_empty() { None } else { Some(join) },
        reminder_minutes: if reminder_on { v.get("reminderMinutesBeforeStart").and_then(|x| x.as_i64()) } else { None },
        is_cancelled: v.get("isCancelled").and_then(|x| x.as_bool()).unwrap_or(false),
        local_only: false,
    }
}

pub fn recipients(list: &[Address]) -> Value {
    Value::Array(list.iter().map(|a| json!({"emailAddress": {"name": a.name, "address": a.email}})).collect())
}

/// Body for creating or updating an event. All-day events are sent as local dates in the local zone.
pub fn event_payload(e: &EventRecord) -> Value {
    let tz = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into());
    let (start, end, zone) = if e.is_all_day {
        let local = |iso: &str| {
            chrono::DateTime::parse_from_rfc3339(iso)
                .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%dT00:00:00").to_string())
                .unwrap_or_else(|_| iso.to_string())
        };
        (local(&e.start), local(&e.end), tz)
    } else {
        (e.start.trim_end_matches('Z').to_string(), e.end.trim_end_matches('Z').to_string(), "UTC".to_string())
    };
    let mut p = json!({
        "subject": e.subject,
        "body": {"contentType": "HTML", "content": e.body_html},
        "start": {"dateTime": start, "timeZone": zone},
        "end": {"dateTime": end, "timeZone": zone},
        "isAllDay": e.is_all_day,
        "location": {"displayName": e.location},
        "attendees": e.attendees.iter().map(|a| json!({
            "emailAddress": {"name": a.address.name, "address": a.address.email},
            "type": match a.kind { AttendeeType::Optional => "optional", AttendeeType::Resource => "resource", AttendeeType::Required => "required" }
        })).collect::<Vec<_>>(),
        "isOnlineMeeting": e.is_online_meeting,
        "isReminderOn": e.reminder_minutes.is_some(),
    });
    if e.is_online_meeting {
        p["onlineMeetingProvider"] = json!("teamsForBusiness");
    }
    if let Some(m) = e.reminder_minutes {
        p["reminderMinutesBeforeStart"] = json!(m);
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_message() {
        let v = json!({
            "id": "AAMk1", "conversationId": "conv1", "subject": "Hello", "bodyPreview": "Hi  there",
            "body": {"contentType": "html", "content": "<p>Hi there</p>"},
            "from": {"emailAddress": {"name": "Sarah Okafor", "address": "Sarah@Harbour.example"}},
            "toRecipients": [{"emailAddress": {"name": "Miles", "address": "miles@coda.example"}}],
            "receivedDateTime": "2026-11-23T09:42:00Z", "isRead": false, "flag": {"flagStatus": "flagged"},
            "hasAttachments": true, "isDraft": false, "parentFolderId": "inbox1"
        });
        let r = message_record(&v, true);
        assert_eq!(r.from.email, "sarah@harbour.example");
        assert_eq!(r.snippet, "Hi there");
        assert!(r.is_flagged && !r.is_read && r.has_attachments);
        assert_eq!(r.body_html.as_deref(), Some("<p>Hi there</p>"));
        assert!(message_record(&v, false).body_html.is_none());
    }

    #[test]
    fn parses_event_times() {
        assert_eq!(graph_time("2026-11-26T10:00:00.0000000"), "2026-11-26T10:00:00Z");
        assert_eq!(graph_time("2026-11-26T10:00:00+01:00"), "2026-11-26T09:00:00Z");
        let v = json!({
            "id": "ev1", "subject": "Steering committee",
            "start": {"dateTime": "2026-11-26T10:00:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": "2026-11-26T12:00:00.0000000", "timeZone": "UTC"},
            "location": {"displayName": "Large meeting room"},
            "organizer": {"emailAddress": {"name": "Sarah Okafor", "address": "sarah@harbour.example"}},
            "attendees": [{"type": "required", "status": {"response": "accepted"}, "emailAddress": {"name": "James Hart", "address": "james@harbour.example"}}],
            "responseStatus": {"response": "tentativelyAccepted"}, "isReminderOn": true, "reminderMinutesBeforeStart": 15
        });
        let e = event_record(&v, "cal1");
        assert_eq!(e.start, "2026-11-26T10:00:00Z");
        assert_eq!(e.my_response, ResponseStatus::Tentative);
        assert_eq!(e.attendees[0].response, ResponseStatus::Accepted);
        assert_eq!(e.reminder_minutes, Some(15));
        let p = event_payload(&e);
        assert_eq!(p["start"]["dateTime"], "2026-11-26T10:00:00");
        assert_eq!(p["start"]["timeZone"], "UTC");
    }

    #[test]
    fn is_organizer_overrides_none_response() {
        let v = json!({
            "id": "ev2", "subject": "Firewood",
            "start": {"dateTime": "2026-11-27T12:00:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": "2026-11-27T13:30:00.0000000", "timeZone": "UTC"},
            "responseStatus": {"response": "none"}, "isOrganizer": true
        });
        assert_eq!(event_record(&v, "cal1").my_response, ResponseStatus::Organizer);
        let v = json!({"id": "ev3", "responseStatus": {"response": "none"}, "isOrganizer": false});
        assert_eq!(event_record(&v, "cal1").my_response, ResponseStatus::None);
    }

    #[test]
    fn partial_delta_item_keeps_stored_details() {
        let full = json!({
            "id": "occ1", "subject": "Pacifica daily sync", "type": "occurrence", "seriesMasterId": "m1",
            "start": {"dateTime": "2026-11-23T16:00:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": "2026-11-23T16:45:00.0000000", "timeZone": "UTC"},
            "location": {"displayName": "Teams"}, "isReminderOn": true, "reminderMinutesBeforeStart": 10
        });
        let base = event_record(&full, "cal1");
        let bare = json!({
            "id": "occ1", "type": "occurrence", "seriesMasterId": "m1",
            "start": {"dateTime": "2026-11-23T16:30:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": "2026-11-23T17:00:00.0000000", "timeZone": "UTC"}
        });
        assert!(is_bare_occurrence(&bare) && !is_bare_occurrence(&full));
        assert_eq!(event_record(&bare, "cal1").subject, "", "no base: nothing to keep");
        let merged = event_record_over(&bare, "cal1", Some(&base));
        assert_eq!(merged.subject, "Pacifica daily sync");
        assert_eq!(merged.location, "Teams");
        assert_eq!(merged.reminder_minutes, Some(10));
        assert_eq!(merged.start, "2026-11-23T16:30:00Z", "new times win");
    }

    #[test]
    fn recognises_meeting_messages() {
        assert_eq!(meeting_type(&json!({"@odata.type": "#microsoft.graph.eventMessageRequest", "id": "m"})).as_deref(), Some("eventMessageRequest"));
        assert_eq!(meeting_type(&json!({"@odata.type": "#microsoft.graph.message", "id": "m"})).as_deref(), Some(""));
        assert_eq!(meeting_type(&json!({"id": "m"})), None, "unknown until checked");
        let rec = message_record(&json!({"@odata.type": "#microsoft.graph.eventMessage", "id": "m", "receivedDateTime": "2026-11-25T16:44:00Z"}), true);
        assert_eq!(rec.meeting_type.as_deref(), Some("eventMessage"));
        // A partial delta item without the type keeps what was stored.
        let merged = message_record_over(&json!({"id": "m", "isRead": true}), true, &rec);
        assert_eq!(merged.meeting_type.as_deref(), Some("eventMessage"));
    }

    #[test]
    fn reads_meeting_details() {
        let v = json!({
            "@odata.type": "#microsoft.graph.eventMessageRequest",
            "id": "m1",
            "meetingMessageType": "meetingRequest",
            "startDateTime": {"dateTime": "2026-11-26T13:00:00.0000000", "timeZone": "UTC"},
            "endDateTime": {"dateTime": "2026-11-26T13:30:00.0000000", "timeZone": "UTC"},
            "isAllDay": false,
            "location": {"displayName": "Microsoft Teams Meeting"},
            "event": {"id": "ev1", "subject": "Project Clarity & InfoSec"}
        });
        let m = meeting_info(&v);
        assert_eq!(m.kind, MeetingKind::Request);
        assert_eq!((m.start.as_str(), m.end.as_str()), ("2026-11-26T13:00:00Z", "2026-11-26T13:30:00Z"));
        assert_eq!(m.location, "Microsoft Teams Meeting");
        assert_eq!(m.event_id.as_deref(), Some("ev1"));

        // Cancellation with the event gone; a response falls back to the event's own times.
        let c = meeting_info(&json!({"meetingMessageType": "meetingCancelled", "startDateTime": {"dateTime": "2026-11-26T13:00:00"}, "event": null}));
        assert_eq!((c.kind, c.event_id), (MeetingKind::Cancelled, None));
        let r = meeting_info(&json!({"responseType": "tentativelyAccepted", "event": {"id": "ev1", "start": {"dateTime": "2026-11-26T13:00:00"}, "end": {"dateTime": "2026-11-26T13:30:00"}}}));
        assert_eq!(r.kind, MeetingKind::Tentative);
        assert_eq!(r.start, "2026-11-26T13:00:00Z");
    }
}
