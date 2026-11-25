//! Web account calendars (docs/WEB_CALENDAR.md): the payload Outlook on the web reports,
//! the refresh window, and validation. The page's report is untrusted input: a structural
//! problem rejects the whole report, a single bad event is dropped.

use crate::db::account::EventRecord;
use crate::error::{Error, Result};
use crate::model::{Address, Attendee, AttendeeType, ResponseStatus};
use crate::service::normalize_time;
use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use serde::Deserialize;
use std::collections::HashMap;

/// The one calendar row a web account has.
pub const CALENDAR_ID: &str = "web-default";
pub const CALENDAR_NAME: &str = "Calendar";

/// Days before today and after today that are read and kept.
pub const WINDOW_BACK_DAYS: i64 = 14;
pub const WINDOW_FORWARD_DAYS: i64 = 42;

pub const MAX_EVENTS: usize = 2000;
pub const MAX_ATTENDEES: usize = 200;
const MAX_ID: usize = 512;
const MAX_SUBJECT: usize = 500;
const MAX_LOCATION: usize = 300;
const MAX_NAME: usize = 200;
const MAX_EMAIL: usize = 320;
const MAX_URL: usize = 2048;
const MAX_ERROR: usize = 40;

/// The window to request, as UTC RFC 3339: local midnight `WINDOW_BACK_DAYS` ago to local
/// midnight `WINDOW_FORWARD_DAYS` ahead.
pub fn window_at<Tz: TimeZone>(now: DateTime<Tz>) -> (String, String) {
    let tz = now.timezone();
    let today = now.date_naive();
    let at = |d| {
        let n = (today + Duration::days(d)).and_hms_opt(0, 0, 0).unwrap();
        let t = tz.from_local_datetime(&n).earliest().unwrap_or_else(|| tz.from_utc_datetime(&n));
        t.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    };
    (at(-WINDOW_BACK_DAYS), at(WINDOW_FORWARD_DAYS + 1))
}

pub fn window() -> (String, String) {
    window_at(Local::now())
}

/// What the page sends back for one request. `events` stay raw JSON so that one malformed
/// event is dropped rather than failing the whole report.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub events: Vec<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PageAddress {
    name: String,
    email: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageAttendee {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    response: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageEvent {
    id: String,
    #[serde(default)]
    subject: String,
    start: String,
    end: String,
    #[serde(default)]
    is_all_day: bool,
    #[serde(default)]
    location: String,
    #[serde(default)]
    organizer: PageAddress,
    #[serde(default)]
    attendees: Vec<PageAttendee>,
    #[serde(default)]
    my_response: Option<String>,
    #[serde(default)]
    is_online_meeting: bool,
    #[serde(default)]
    online_meeting_url: Option<String>,
    #[serde(default)]
    is_cancelled: bool,
}

fn cap(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        t.chars().take(max).collect::<String>().trim_end().to_string()
    }
}

fn response(s: Option<&str>) -> ResponseStatus {
    match s.unwrap_or("") {
        "organizer" => ResponseStatus::Organizer,
        "accepted" => ResponseStatus::Accepted,
        "tentative" => ResponseStatus::Tentative,
        "declined" => ResponseStatus::Declined,
        _ => ResponseStatus::None,
    }
}

fn attendee_type(s: Option<&str>) -> AttendeeType {
    match s.unwrap_or("") {
        "optional" => AttendeeType::Optional,
        "resource" => AttendeeType::Resource,
        _ => AttendeeType::Required,
    }
}

/// Strict RFC 3339 (with offset) or a plain date for all-day events. Naive local times are
/// not accepted from the page: they are ambiguous.
fn page_time(s: &str, all_day: bool) -> Option<String> {
    let s = s.trim();
    if DateTime::parse_from_rfc3339(s).is_ok() || (all_day && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()) {
        normalize_time(s).ok()
    } else {
        None
    }
}

fn meeting_url(u: Option<&str>) -> Option<String> {
    let u = u?.trim();
    if u.len() > MAX_URL {
        return None;
    }
    let parsed = url::Url::parse(u).ok()?;
    (parsed.scheme() == "https" && parsed.host_str().is_some()).then(|| parsed.to_string())
}

/// True when [start, end) overlaps [range_start, range_end); a zero-length event counts when it
/// sits inside the range. Same rule as `AccountDb::replace_events_in_range`.
fn overlaps(start: &str, end: &str, range_start: &str, range_end: &str) -> bool {
    start < range_end && (end > range_start || start >= range_start)
}

/// Normalise an attendee list reported by the page: names and emails capped, count limited,
/// and entries with neither a name nor an email dropped. Shared by the calendar-view events and
/// the on-demand attendee fetch (see `parse_attendees`).
fn attendees(list: &[PageAttendee]) -> Vec<Attendee> {
    list.iter()
        .take(MAX_ATTENDEES)
        .map(|a| Attendee {
            address: Address::new(cap(&a.name, MAX_NAME), cap(&a.email, MAX_EMAIL)),
            kind: attendee_type(a.kind.as_deref()),
            response: response(a.response.as_deref()),
        })
        .filter(|a| !a.address.email.is_empty() || !a.address.name.is_empty())
        .collect()
}

/// Parse an attendee list reported by the page for a single event (the on-demand GetItem path,
/// see webaccounts `fetch_web_event_attendees`). Same validation as the calendar view's events.
pub fn parse_attendees(list: &[serde_json::Value]) -> Vec<Attendee> {
    let page: Vec<PageAttendee> = list.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect();
    attendees(&page)
}

fn event(v: &serde_json::Value, range_start: &str, range_end: &str) -> Option<EventRecord> {
    let e: PageEvent = serde_json::from_value(v.clone()).ok()?;
    let id = cap(&e.id, MAX_ID);
    if id.is_empty() {
        return None;
    }
    let start = page_time(&e.start, e.is_all_day)?;
    let end = page_time(&e.end, e.is_all_day)?;
    if end < start || !overlaps(&start, &end, range_start, range_end) {
        return None;
    }
    let addr = |name: &str, email: &str| Address::new(cap(name, MAX_NAME), cap(email, MAX_EMAIL));
    let attendees = attendees(&e.attendees);
    let online_meeting_url = meeting_url(e.online_meeting_url.as_deref());
    Some(EventRecord {
        id,
        calendar_id: CALENDAR_ID.to_string(),
        subject: cap(&e.subject, MAX_SUBJECT),
        start,
        end,
        is_all_day: e.is_all_day,
        location: cap(&e.location, MAX_LOCATION),
        body_html: String::new(),
        organizer: addr(&e.organizer.name, &e.organizer.email),
        attendees,
        my_response: response(e.my_response.as_deref()),
        is_online_meeting: e.is_online_meeting || online_meeting_url.is_some(),
        online_meeting_url,
        reminder_minutes: None,
        is_cancelled: e.is_cancelled,
        local_only: false,
    })
}

/// A short, safe error code from the page (`signed_out`, `http_401`, ...).
pub fn error_code(s: &str) -> String {
    let code: String = s.trim().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(MAX_ERROR).collect();
    if code.is_empty() {
        "unknown".into()
    } else {
        code
    }
}

/// Validate a successful report against the range that was requested. Returns the events to
/// store (deduplicated by id, last wins), or an error code when the whole report is rejected.
pub fn validate(report: &Report, range_start: &str, range_end: &str) -> std::result::Result<Vec<EventRecord>, &'static str> {
    if report.start != range_start || report.end != range_end {
        return Err("range");
    }
    if report.events.len() > MAX_EVENTS {
        return Err("too_many");
    }
    let mut order: Vec<String> = vec![];
    let mut by_id: HashMap<String, EventRecord> = HashMap::new();
    for v in &report.events {
        if let Some(e) = event(v, range_start, range_end) {
            if !by_id.contains_key(&e.id) {
                order.push(e.id.clone());
            }
            by_id.insert(e.id.clone(), e);
        }
    }
    Ok(order.into_iter().filter_map(|id| by_id.remove(&id)).collect())
}

/// Parse the range the shell asked for (both ends RFC 3339, end after start).
pub fn check_range(start: &str, end: &str) -> Result<()> {
    let s = DateTime::parse_from_rfc3339(start).map_err(|_| Error::Invalid("bad range start".into()))?;
    let e = DateTime::parse_from_rfc3339(end).map_err(|_| Error::Invalid("bad range end".into()))?;
    if e <= s {
        return Err(Error::Invalid("empty range".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const S: &str = "2026-11-09T00:00:00Z";
    const E: &str = "2027-01-05T00:00:00Z";

    fn report(events: Vec<serde_json::Value>) -> Report {
        Report { start: S.into(), end: E.into(), events, error: None }
    }

    fn ev(id: &str, start: &str, end: &str) -> serde_json::Value {
        json!({ "id": id, "subject": "Meeting", "start": start, "end": end, "isAllDay": false, "location": "", "organizer": { "name": "A", "email": "a@x.com" }, "attendees": [], "myResponse": "accepted", "isOnlineMeeting": false, "isCancelled": false })
    }

    #[test]
    fn window_is_two_weeks_back_six_forward() {
        let now = Utc.with_ymd_and_hms(2026, 11, 23, 9, 50, 0).unwrap();
        let (s, e) = window_at(now);
        assert_eq!(s, "2026-11-09T00:00:00Z");
        assert_eq!(e, "2027-01-05T00:00:00Z");
    }

    #[test]
    fn caps_strings_and_drops_bad_events() {
        let mut long = ev("a", "2026-11-23T10:00:00+01:00", "2026-11-23T11:00:00+01:00");
        long["subject"] = json!("x".repeat(600));
        long["location"] = json!(format!("  {}  ", "y".repeat(400)));
        long["attendees"] = json!((0..250).map(|i| json!({ "name": "n".repeat(300), "email": format!("p{i}@x.com"), "type": "optional", "response": "tentative" })).collect::<Vec<_>>());
        long["onlineMeetingUrl"] = json!("https://teams.microsoft.com/l/meetup-join/abc");
        let mut http = ev("b", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z");
        http["onlineMeetingUrl"] = json!("http://evil.example/");
        let mut js = ev("c", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z");
        js["onlineMeetingUrl"] = json!("javascript:alert(1)");
        let list = validate(
            &report(vec![
                long,
                http,
                js,
                ev("bad-time", "tomorrow", "2026-11-24T11:00:00Z"),
                ev("naive", "2026-11-24T10:00:00", "2026-11-24T11:00:00"),
                ev("backwards", "2026-11-24T12:00:00Z", "2026-11-24T11:00:00Z"),
                ev("outside", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
                ev("", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z"),
                json!({ "id": 5 }),
                json!("not an event"),
            ]),
            S,
            E,
        )
        .unwrap();
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        let a = &list[0];
        assert_eq!(a.subject.chars().count(), 500);
        assert_eq!(a.location.chars().count(), 300);
        assert_eq!(a.attendees.len(), 200);
        assert_eq!(a.attendees[0].address.name.chars().count(), 200);
        assert_eq!(a.attendees[0].kind, AttendeeType::Optional);
        assert_eq!(a.start, "2026-11-23T09:00:00Z", "stored in UTC");
        assert!(a.is_online_meeting);
        assert_eq!(a.online_meeting_url.as_deref(), Some("https://teams.microsoft.com/l/meetup-join/abc"));
        assert_eq!(list[1].online_meeting_url, None, "http links dropped");
        assert_eq!(list[2].online_meeting_url, None, "javascript links dropped");
        assert!(a.reminder_minutes.is_none() && a.body_html.is_empty() && !a.local_only);
    }

    #[test]
    fn all_day_dates_and_dedupe() {
        let mut day = ev("d", "2026-11-25", "2026-11-26");
        day["isAllDay"] = json!(true);
        let not_all_day = ev("n", "2026-11-25", "2026-11-26");
        let first = ev("x", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z");
        let mut second = ev("x", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z");
        second["subject"] = json!("Moved");
        let list = validate(&report(vec![day, not_all_day, first, second]), S, E).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].is_all_day);
        assert_eq!(list[1].subject, "Moved", "last wins");
    }

    #[test]
    fn rejects_whole_report() {
        let many: Vec<_> = (0..=MAX_EVENTS).map(|i| ev(&format!("e{i}"), "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")).collect();
        assert_eq!(validate(&report(many), S, E).unwrap_err(), "too_many");
        let mut r = report(vec![]);
        r.end = "2027-02-01T00:00:00Z".into();
        assert_eq!(validate(&r, S, E).unwrap_err(), "range");
    }

    #[test]
    fn error_codes_are_sanitised() {
        assert_eq!(error_code("http_401"), "http_401");
        assert_eq!(error_code("<script>alert(1)</script>"), "scriptalert1script");
        assert_eq!(error_code("   "), "unknown");
    }

    #[test]
    fn parse_attendees_validates_like_events() {
        let list: Vec<serde_json::Value> = vec![
            json!({ "name": "n".repeat(300), "email": "a@x.com", "type": "optional", "response": "accepted" }),
            json!({ "name": "Bob", "email": "b@x.com", "type": "resource", "response": "declined" }),
            // Neither a name nor an email: dropped.
            json!({ "name": "", "email": "", "type": "required" }),
            // An unknown type falls back to required; unknown response to none.
            json!({ "name": "Cara", "email": "c@x.com", "type": "chair", "response": "huh" }),
        ];
        let out = parse_attendees(&list);
        assert_eq!(out.len(), 3, "the name/email-less entry is dropped");
        assert_eq!(out[0].address.name.chars().count(), 200, "name capped");
        assert_eq!(out[0].kind, AttendeeType::Optional);
        assert_eq!(out[0].response, ResponseStatus::Accepted);
        assert_eq!(out[1].kind, AttendeeType::Resource);
        assert_eq!(out[1].response, ResponseStatus::Declined);
        assert_eq!(out[2].kind, AttendeeType::Required, "unknown type → required");
        assert_eq!(out[2].response, ResponseStatus::None, "unknown response → none");
    }

    #[test]
    fn parse_attendees_caps_count() {
        let list: Vec<serde_json::Value> = (0..250).map(|i| json!({ "name": format!("p{i}"), "email": format!("p{i}@x.com") })).collect();
        assert_eq!(parse_attendees(&list).len(), MAX_ATTENDEES);
    }
}
