//! "Find times": read the meeting times an email proposes, with a language model reached
//! through the Vercel AI Gateway.
//!
//! Only the email goes to the model. It returns each proposed time as a local date and
//! clock time in a named time zone; converting to UTC, checking the weekday the sender wrote
//! against the date, and checking the user's calendar all happen here and in the interface,
//! never in the model.

use crate::error::{Error, Result};
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc, Weekday};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The Vercel AI Gateway's OpenAI-compatible endpoint.
pub const GATEWAY_URL: &str = "https://ai-gateway.vercel.sh/v1/chat/completions";
/// Cheap and quick, with structured output: about $0.0005 per email.
pub const DEFAULT_MODEL: &str = "openai/gpt-6-luna";
/// The gateway key's entry in the OS credential store (beside the accounts' refresh tokens).
pub const KEY_ID: &str = "ai-gateway-key";
/// Long threads are cut here: the proposal is near the top, history is only context.
const MAX_BODY_CHARS: usize = 24_000;
/// Meeting length when nobody says (shown to the user as an assumption).
const DEFAULT_LENGTH: i64 = 30;

/// The email, as sent to the model.
#[derive(Debug, Clone)]
pub struct EmailInput {
    pub subject: String,
    pub from_name: String,
    /// The user's own name, so "Hi Miles" and "Miles's diary" read correctly.
    pub me_name: String,
    pub sent_at: DateTime<Utc>,
    /// Plain text, newest message first, quoted history after.
    pub body_text: String,
}

/// How a proposed time is meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotKind {
    /// The meeting fills this time exactly ("11:30-12:30", "Thursday 2pm").
    Exact,
    /// The sender is free for this span; the meeting can sit anywhere in it ("between 11:00 and 13:00").
    Window,
    /// The meeting can start anywhere in this span ("starting between 9:30am and 11:00am").
    StartBetween,
}

/// One proposed time, ready to check against the calendar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedSlot {
    pub kind: SlotKind,
    /// The span the meeting has to fit in, UTC ISO 8601. For `startBetween` this runs to the
    /// latest start plus the meeting's length.
    pub window_start: String,
    pub window_end: String,
    /// The meeting's length in minutes (equals the window for `exact`).
    pub minutes: i64,
    /// The zone the sender meant (IANA), for showing their own clock alongside the user's.
    pub time_zone: String,
    /// The words in the email this came from.
    pub quote: String,
    /// The model's caveat, e.g. "‘Friday morning’ read as 09:00–12:00".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Read from loose wording ("Friday morning", "end of the week").
    pub approximate: bool,
    /// Problems found checking the model's answer (weekday doesn't match the date, length assumed...).
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeProposals {
    /// One line on what the email proposes, including times that won't work.
    pub summary: String,
    /// The meeting's length in minutes, when the thread says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<i64>,
    pub slots: Vec<ProposedSlot>,
    pub model: String,
}

// ------------------------------------------------------------------ the model's answer

#[derive(Debug, Deserialize)]
struct RawAnswer {
    summary: String,
    meeting_minutes: Option<i64>,
    slots: Vec<RawSlot>,
}

#[derive(Debug, Deserialize)]
struct RawSlot {
    date: String,
    weekday_written: Option<String>,
    start: String,
    end: Option<String>,
    kind: String,
    time_zone: String,
    approximate: bool,
    quote: String,
    note: Option<String>,
}

fn nullable(t: &str) -> Value {
    json!({ "type": [t, "null"] })
}

/// JSON schema for structured output (strict: every field present, nulls allowed where optional).
fn answer_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "meeting_minutes", "slots"],
        "properties": {
            "summary": { "type": "string", "description": "One short sentence: what the newest message proposes, including times the sender says won't work." },
            "meeting_minutes": { "type": ["integer", "null"], "description": "Meeting length in minutes if the thread states or clearly implies it, else null." },
            "slots": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["date", "weekday_written", "start", "end", "kind", "time_zone", "approximate", "quote", "note"],
                    "properties": {
                        "date": { "type": "string", "description": "YYYY-MM-DD" },
                        "weekday_written": { "type": ["string", "null"], "description": "The weekday as the email names it for this date (e.g. \"Wednesday\", \"Thu\"), or null if none is written." },
                        "start": { "type": "string", "description": "HH:MM, 24-hour, in time_zone" },
                        "end": { "type": ["string", "null"], "description": "HH:MM, 24-hour, in time_zone; null when only a start time is given" },
                        "kind": { "type": "string", "enum": ["exact", "window", "start_between"] },
                        "time_zone": { "type": "string", "description": "IANA zone the times are written in, e.g. Europe/London, America/New_York" },
                        "approximate": { "type": "boolean" },
                        "quote": { "type": "string", "description": "The exact words in the email this slot comes from" },
                        "note": nullable("string"),
                    }
                }
            }
        }
    })
}

const INSTRUCTIONS: &str = "You read an email and list the meeting times it proposes, as structured data. \
You do not know the reader's calendar and must not judge availability.

Which times to list:
- Only times offered or requested in the NEWEST message (the text before the first quoted header such as \"From: … Sent:\", \"On … wrote:\" or \"-----Original Message-----\"). Use the quoted history only to understand references: which date \"Thursday\" means, the meeting length, the time zone.
- If the newest message accepts or narrows earlier options (\"Thursday 2pm works for me\"), list exactly what it accepts.
- Never list times the sender says do NOT work; mention them in the summary instead.
- Skip times of meetings that already happened, and calendar boilerplate (\"When: …\" lines of quoted invitations).
- If the email proposes no concrete or approximate day, return no slots.

How to read times:
- Resolve every date using the sent date and the calendar provided. A weekday on its own means the next such day after the sent date, unless the thread clearly refers to another one (\"this Thursday\", \"next week\", or a date mentioned earlier in the thread). When a weekday and a day number are both written (\"Thursday 12th\"), pick the month where they agree.
- One am/pm applies to both ends of a range (\"4-5pm\" = 16:00-17:00), but \"10-12pm\" = 10:00-12:00 and \"11-1pm\" = 11:00-13:00. \"1130-1230\" = 11:30-12:30. \"4.30\" = 04:30 or 16:30 by context (business hours).
- kind \"exact\": the meeting fills start-end, or starts at start when no end is given.
  kind \"window\": the sender is free for a span longer than the meeting (\"between 11:00 – 13:00\" for a 30 min call, \"Friday morning\").
  kind \"start_between\": the meeting may START anywhere from start to end (\"starting between 9:30am and 11:00am\").
- A list item with several ranges on one day is several slots. A date on its own line applies to the times listed under it.
- Loose phrases: morning = 09:00-12:00, afternoon = 13:00-17:00, end of day = 16:00-18:00; set approximate true and say how you read it in note. Phrases with no day at all (\"sometime next week\") give no slot.
- time_zone: the zone the email states (UK, UKT, GMT, BST and London = Europe/London; ET, EST, EDT = America/New_York; CET = Europe/Paris; PT = America/Los_Angeles). If none is stated, use the reader's time zone.
- quote: copy the words from the email exactly, as short as possible but recognisable.
- note: only for an assumption the reader should know about; otherwise null.";

/// A day-by-day calendar around the sent date, so the model doesn't have to work out weekdays.
fn calendar_lines(from: NaiveDate) -> String {
    let mut out = String::new();
    let mut d = from - Duration::days(14);
    let end = from + Duration::days(120);
    while d <= end {
        out.push_str(&d.format("%a %Y-%m-%d").to_string());
        out.push(if d.weekday() == Weekday::Sun { '\n' } else { ' ' });
        d += Duration::days(1);
    }
    out
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// The chat request for the gateway.
pub fn build_request(model: &str, email: &EmailInput, user_tz: Tz) -> Value {
    let sent_local = email.sent_at.with_timezone(&user_tz);
    let context = format!(
        "Reader: {me}\nReader's time zone: {tz}\nSent: {sent} ({tz})\n\nCalendar (weekday, date):\n{cal}",
        me = if email.me_name.is_empty() { "(unknown)" } else { &email.me_name },
        tz = user_tz.name(),
        sent = sent_local.format("%A %-d %B %Y, %H:%M"),
        cal = calendar_lines(sent_local.date_naive()),
    );
    let mail = format!(
        "From: {from}\nSubject: {subject}\n\n{body}",
        from = email.from_name,
        subject = email.subject,
        body = truncate(&email.body_text, MAX_BODY_CHARS),
    );
    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": INSTRUCTIONS },
            { "role": "user", "content": format!("{context}\n\n<email>\n{mail}\n</email>") },
        ],
        "reasoning_effort": "low",
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "proposed_times", "strict": true, "schema": answer_schema() },
        },
    })
}

// ------------------------------------------------------------------ checking the answer

fn parse_weekday(s: &str) -> Option<Weekday> {
    let s = s.trim().to_ascii_lowercase();
    let w = s.get(..3)?;
    Some(match w {
        "mon" => Weekday::Mon,
        "tue" => Weekday::Tue,
        "wed" => Weekday::Wed,
        "thu" => Weekday::Thu,
        "fri" => Weekday::Fri,
        "sat" => Weekday::Sat,
        "sun" => Weekday::Sun,
        _ => return None,
    })
}

fn weekday_name(w: Weekday) -> &'static str {
    match w {
        Weekday::Mon => "Monday",
        Weekday::Tue => "Tuesday",
        Weekday::Wed => "Wednesday",
        Weekday::Thu => "Thursday",
        Weekday::Fri => "Friday",
        Weekday::Sat => "Saturday",
        Weekday::Sun => "Sunday",
    }
}

fn parse_time(s: &str) -> Option<NaiveTime> {
    let s = s.trim();
    if s == "24:00" {
        return NaiveTime::from_hms_opt(23, 59, 0);
    }
    NaiveTime::parse_from_str(s, "%H:%M").ok()
}

/// Local wall-clock time to UTC. A time skipped by a clock change moves forward an hour.
fn to_utc(tz: Tz, local: NaiveDateTime) -> Option<DateTime<Utc>> {
    tz.from_local_datetime(&local)
        .earliest()
        .or_else(|| tz.from_local_datetime(&(local + Duration::hours(1))).earliest())
        .map(|t| t.with_timezone(&Utc))
}

/// The zone the model named. Abbreviations people write are mapped to the region they mean,
/// so clock changes apply: "EST" in an email means New York time, not a fixed UTC−5
/// (tz data has fixed `EST`, `MST` and `HST` zones that would be an hour out all summer).
fn parse_zone(name: &str) -> Option<Tz> {
    let n = name.trim();
    let region = match n.to_ascii_uppercase().as_str() {
        "UK" | "UKT" | "GMT" | "BST" | "LONDON" | "EUROPE/LONDON" | "GB" => "Europe/London",
        "ET" | "EST" | "EDT" | "EST5EDT" | "US/EASTERN" => "America/New_York",
        "CT" | "CST" | "CDT" | "CST6CDT" | "US/CENTRAL" => "America/Chicago",
        "MT" | "MST" | "MDT" | "MST7MDT" | "US/MOUNTAIN" => "America/Denver",
        "PT" | "PST" | "PDT" | "PST8PDT" | "US/PACIFIC" => "America/Los_Angeles",
        "CET" | "CEST" => "Europe/Paris",
        "EET" | "EEST" => "Europe/Athens",
        "IST" => "Asia/Kolkata",
        "SGT" => "Asia/Singapore",
        "HKT" => "Asia/Hong_Kong",
        "JST" => "Asia/Tokyo",
        "AEST" | "AEDT" => "Australia/Sydney",
        "UTC" | "Z" => "UTC",
        _ => n,
    };
    region.parse().ok()
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Turns the model's answer into slots, converting zones and noting anything that doesn't add up.
/// Slots that can't be read at all are dropped; the rest are kept with warnings.
fn check(raw: RawAnswer, model: &str, user_tz: Tz, sent_at: DateTime<Utc>) -> TimeProposals {
    let length = raw.meeting_minutes.filter(|m| (5..=8 * 60).contains(m));
    let mut slots = Vec::new();
    for r in raw.slots {
        let Ok(date) = NaiveDate::parse_from_str(r.date.trim(), "%Y-%m-%d") else { continue };
        let Some(start) = parse_time(&r.start) else { continue };
        let mut warnings = Vec::new();
        let tz = match parse_zone(&r.time_zone) {
            Some(tz) => tz,
            None => {
                warnings.push(format!("Time zone “{}” not recognised; read as your own", r.time_zone));
                user_tz
            }
        };
        if let Some(written) = r.weekday_written.as_deref().filter(|w| !w.trim().is_empty()) {
            if let Some(w) = parse_weekday(written) {
                if w != date.weekday() {
                    warnings.push(format!("The email says {}, but {} is a {}", weekday_name(w), date.format("%-d %B"), weekday_name(date.weekday())));
                }
            }
        }
        let kind = match r.kind.as_str() {
            "window" => SlotKind::Window,
            "start_between" => SlotKind::StartBetween,
            _ => SlotKind::Exact,
        };
        let Some(t0) = to_utc(tz, date.and_time(start)) else { continue };
        let mut end = r.end.as_deref().and_then(parse_time).and_then(|e| to_utc(tz, date.and_time(e)));
        if end.is_some_and(|e| e <= t0) {
            warnings.push("The end time is before the start; length assumed".into());
            end = None;
        }
        // The meeting's length where the slot itself doesn't fix it, saying so when it's a guess.
        let length_or_default = |warnings: &mut Vec<String>| {
            let m = length.unwrap_or(DEFAULT_LENGTH);
            if length.is_none() {
                warnings.push(format!("No length given; {m} minutes assumed"));
            }
            m
        };
        let (window_end, minutes) = match (kind, end) {
            (SlotKind::Exact, Some(e)) => (e, (e - t0).num_minutes()),
            (SlotKind::Window, Some(e)) => {
                let span = (e - t0).num_minutes();
                (e, length.map(|m| m.min(span)).unwrap_or(span))
            }
            (SlotKind::StartBetween, Some(e)) => {
                let m = length_or_default(&mut warnings);
                (e + Duration::minutes(m), m)
            }
            // Only a start time (a window or start range with no end is the same).
            (_, None) => {
                let m = length_or_default(&mut warnings);
                (t0 + Duration::minutes(m), m)
            }
        };
        if window_end < sent_at - Duration::days(1) {
            warnings.push("This is before the email was sent".into());
        }
        let kind = if (window_end - t0).num_minutes() == minutes { SlotKind::Exact } else { kind };
        slots.push(ProposedSlot {
            kind,
            window_start: iso(t0),
            window_end: iso(window_end),
            minutes,
            time_zone: tz.name().to_string(),
            quote: r.quote.trim().to_string(),
            note: r.note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
            approximate: r.approximate,
            warnings,
        });
    }
    slots.sort_by(|a, b| a.window_start.cmp(&b.window_start));
    slots.dedup_by(|a, b| a.window_start == b.window_start && a.window_end == b.window_end && a.minutes == b.minutes);
    TimeProposals { summary: raw.summary.trim().to_string(), minutes: length, slots, model: model.to_string() }
}

/// Reads the structured answer out of a chat completion.
pub fn parse_response(body: &Value, model: &str, user_tz: Tz, sent_at: DateTime<Utc>) -> Result<TimeProposals> {
    let choice = &body["choices"][0];
    if choice["finish_reason"] == "length" {
        return Err(Error::Other("The AI's answer was cut short; try again".into()));
    }
    let message = &choice["message"];
    if let Some(refusal) = message["refusal"].as_str().filter(|r| !r.is_empty()) {
        return Err(Error::Other(format!("The AI declined: {refusal}")));
    }
    let content = message["content"].as_str().ok_or_else(|| Error::Other("The AI gave no answer".into()))?;
    let raw: RawAnswer = serde_json::from_str(content).map_err(|e| Error::Other(format!("The AI's answer couldn't be read: {e}")))?;
    Ok(check(raw, model, user_tz, sent_at))
}

/// The user's time zone, falling back to UTC.
pub fn local_tz() -> Tz {
    iana_time_zone::get_timezone().ok().and_then(|n| n.parse().ok()).unwrap_or(Tz::UTC)
}

/// Asks the gateway for the times `email` proposes.
pub async fn find(http: &reqwest::Client, url: &str, key: &str, model: &str, email: &EmailInput, user_tz: Tz) -> Result<TimeProposals> {
    let req = build_request(model, email, user_tz);
    let resp = http.post(url).bearer_auth(key).timeout(std::time::Duration::from_secs(60)).json(&req).send().await?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = body["error"]["message"].as_str().or_else(|| body["error"].as_str()).unwrap_or("").to_string();
        return Err(match status.as_u16() {
            401 | 403 => Error::Invalid("The AI Gateway key was refused. Check it in Settings › General".into()),
            402 => Error::Other("The AI Gateway account is out of credit".into()),
            429 => Error::Other("The AI Gateway is busy or over its limit; try again shortly".into()),
            404 | 400 if detail.to_lowercase().contains("model") => Error::Invalid(format!("Model “{model}” isn't available: {detail}")),
            s => Error::Other(format!("AI Gateway {s}: {detail}")),
        });
    }
    parse_response(&body, model, user_tz, email.sent_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn london() -> Tz {
        "Europe/London".parse().unwrap()
    }

    fn sent() -> DateTime<Utc> {
        "2026-11-27T14:24:00Z".parse().unwrap()
    }

    fn answer(slots: Value, minutes: Value) -> Value {
        json!({ "choices": [{ "finish_reason": "stop", "message": { "content": json!({ "summary": "s", "meeting_minutes": minutes, "slots": slots }).to_string() } }] })
    }

    fn slot(date: &str, weekday: Option<&str>, start: &str, end: Option<&str>, kind: &str, tz: &str) -> Value {
        json!({ "date": date, "weekday_written": weekday, "start": start, "end": end, "kind": kind, "time_zone": tz, "approximate": false, "quote": "q", "note": null })
    }

    #[test]
    fn exact_ranges_convert_to_utc() {
        let body = answer(json!([slot("2026-12-16", Some("Wednesday"), "11:30", Some("12:30"), "exact", "Europe/London")]), Value::Null);
        let p = parse_response(&body, "m", london(), sent()).unwrap();
        let s = &p.slots[0];
        assert_eq!((s.window_start.as_str(), s.window_end.as_str(), s.minutes, s.kind), ("2026-12-16T11:30:00Z", "2026-12-16T12:30:00Z", 60, SlotKind::Exact));
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn summer_time_and_other_zones() {
        // 15:00 New York on 2 Nov 2026 (EST) is 20:00 UTC; 11:00 London in June (BST) is 10:00 UTC.
        let body = answer(
            json!([
                slot("2026-11-02", None, "15:00", Some("16:00"), "exact", "America/New_York"),
                slot("2026-06-10", None, "11:00", Some("12:00"), "exact", "Europe/London"),
            ]),
            Value::Null,
        );
        let p = parse_response(&body, "m", london(), "2026-05-01T00:00:00Z".parse().unwrap()).unwrap();
        let starts: Vec<_> = p.slots.iter().map(|s| (s.window_start.as_str(), s.time_zone.as_str())).collect();
        assert_eq!(starts, vec![("2026-06-10T10:00:00Z", "Europe/London"), ("2026-11-02T20:00:00Z", "America/New_York")]);
    }

    #[test]
    fn abbreviations_follow_summer_time() {
        // 4pm "EST" on 29 Oct 2026 is New York summer time (UTC−4): 20:00 UTC, not 21:00.
        let body = answer(json!([slot("2026-10-29", None, "16:00", Some("17:00"), "exact", "EST")]), Value::Null);
        let p = parse_response(&body, "m", london(), "2026-10-28T09:37:00Z".parse().unwrap()).unwrap();
        assert_eq!((p.slots[0].window_start.as_str(), p.slots[0].time_zone.as_str()), ("2026-10-29T20:00:00Z", "America/New_York"));
        assert!(p.slots[0].warnings.is_empty());
        assert_eq!(parse_zone("BST"), Some(london()));
        assert_eq!(parse_zone("Asia/Dubai").map(|t| t.name()), Some("Asia/Dubai"));
        assert_eq!(parse_zone("Mars/Olympus"), None);
    }

    #[test]
    fn weekday_that_disagrees_with_the_date_is_flagged() {
        let body = answer(json!([slot("2026-12-17", Some("Wednesday"), "11:00", Some("12:00"), "exact", "Europe/London")]), Value::Null);
        let p = parse_response(&body, "m", london(), sent()).unwrap();
        assert_eq!(p.slots[0].warnings, vec!["The email says Wednesday, but 17 December is a Thursday"]);
    }

    #[test]
    fn windows_and_start_ranges_carry_the_meeting_length() {
        let body = answer(
            json!([
                slot("2026-10-06", Some("Tuesday"), "11:00", Some("13:00"), "window", "Europe/London"),
                slot("2026-11-09", Some("Mon"), "09:30", Some("11:00"), "start_between", "Europe/London"),
            ]),
            json!(30),
        );
        let p = parse_response(&body, "m", london(), "2026-10-01T08:00:00Z".parse().unwrap()).unwrap();
        let w = &p.slots[0];
        assert_eq!((w.kind, w.minutes, w.window_start.as_str(), w.window_end.as_str()), (SlotKind::Window, 30, "2026-10-06T10:00:00Z", "2026-10-06T12:00:00Z"));
        let s = &p.slots[1];
        // Latest start 11:00 GMT plus 30 minutes.
        assert_eq!((s.kind, s.minutes, s.window_end.as_str()), (SlotKind::StartBetween, 30, "2026-11-09T11:30:00Z"));
        assert_eq!(p.minutes, Some(30));
    }

    #[test]
    fn start_times_alone_assume_a_length_and_say_so() {
        let body = answer(json!([slot("2026-10-15", Some("Thu"), "11:30", None, "exact", "Europe/London")]), Value::Null);
        let p = parse_response(&body, "m", london(), "2026-09-29T12:00:00Z".parse().unwrap()).unwrap();
        let s = &p.slots[0];
        assert_eq!((s.minutes, s.window_end.as_str()), (30, "2026-10-15T11:00:00Z"));
        assert_eq!(s.warnings, vec!["No length given; 30 minutes assumed"]);
    }

    #[test]
    fn unreadable_slots_are_dropped_and_odd_ones_flagged() {
        let body = answer(
            json!([
                slot("16 Dec", None, "11:00", None, "exact", "Europe/London"),
                slot("2026-12-16", None, "14:00", Some("13:00"), "exact", "Mars/Olympus"),
                slot("2026-01-05", None, "10:00", Some("11:00"), "exact", "Europe/London"),
            ]),
            Value::Null,
        );
        let p = parse_response(&body, "m", london(), sent()).unwrap();
        assert_eq!(p.slots.len(), 2);
        assert_eq!(p.slots[0].warnings, vec!["This is before the email was sent"]);
        assert!(p.slots[1].warnings[0].contains("not recognised"));
        assert!(p.slots[1].warnings[1].contains("before the start"));
    }

    #[test]
    fn request_carries_the_email_calendar_and_schema() {
        let email = EmailInput { subject: "RE: Catch up".into(), from_name: "Lucy".into(), me_name: "Miles".into(), sent_at: sent(), body_text: "Wednesday 16th December 1130-1230".into() };
        let req = build_request("openai/gpt-6-luna", &email, london());
        let user = req["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains("Sent: Friday 27 November 2026, 14:24 (Europe/London)"));
        assert!(user.contains("Wed 2026-12-16"));
        assert!(user.contains("Wednesday 16th December 1130-1230"));
        assert_eq!(req["response_format"]["json_schema"]["strict"], true);
        assert_eq!(req["model"], "openai/gpt-6-luna");
    }

    #[test]
    fn errors_from_the_model_are_readable() {
        let cut = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "{" } }] });
        assert!(parse_response(&cut, "m", london(), sent()).unwrap_err().to_string().contains("cut short"));
        let junk = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "not json" } }] });
        assert!(parse_response(&junk, "m", london(), sent()).is_err());
    }
}
