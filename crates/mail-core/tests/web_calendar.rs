//! Web account calendars read from Outlook on the web (docs/WEB_CALENDAR.md §5).

use chrono::{Local, TimeZone, Utc};
use mail_core::db::account::EventRecord;
use mail_core::model::*;
use mail_core::webcal::{self, Report};
use mail_core::{demo, EventSink, MailService};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const S: &str = "2026-11-09T00:00:00Z";
const E: &str = "2027-01-05T00:00:00Z";

#[derive(Default)]
struct Counts {
    mail: AtomicUsize,
    accounts: AtomicUsize,
}

impl EventSink for Counts {
    fn mail_changed(&self, _: &[String]) {
        self.mail.fetch_add(1, Ordering::SeqCst);
    }
    fn accounts_changed(&self) {
        self.accounts.fetch_add(1, Ordering::SeqCst);
    }
}

impl Counts {
    fn take(&self) -> (usize, usize) {
        (self.mail.swap(0, Ordering::SeqCst), self.accounts.swap(0, Ordering::SeqCst))
    }
}

fn setup() -> (MailService, demo::DemoIds, Arc<Counts>) {
    let svc = MailService::in_memory().unwrap();
    let now = Local.with_ymd_and_hms(2026, 11, 23, 9, 50, 0).unwrap();
    let ids = demo::seed_at(&svc, now).unwrap();
    let counts = Arc::new(Counts::default());
    svc.set_events(counts.clone());
    (svc, ids, counts)
}

fn turn_on(svc: &MailService, id: &str) {
    svc.update_account(id, &AccountPatch { web_calendar: Some(true), ..Default::default() }).unwrap();
}

fn ev(id: &str, subject: &str, start: &str, end: &str) -> serde_json::Value {
    json!({
        "id": id, "subject": subject, "start": start, "end": end, "isAllDay": false, "location": "Room 4",
        "organizer": { "name": "Ana Silva", "email": "ana@aldgatecapital.example" },
        "attendees": [{ "name": "Ana Silva", "email": "ana@aldgatecapital.example", "type": "required", "response": "organizer" }],
        "myResponse": "accepted", "isOnlineMeeting": true, "onlineMeetingUrl": "https://teams.microsoft.com/l/meetup-join/1", "isCancelled": false
    })
}

fn ok(events: Vec<serde_json::Value>) -> Report {
    Report { start: S.into(), end: E.into(), events, error: None }
}

fn failed(code: &str) -> Report {
    Report { start: S.into(), end: E.into(), events: vec![], error: Some(code.into()) }
}

fn web_subjects(svc: &MailService, acc: &str) -> Vec<String> {
    svc.list_events("2026-10-01T00:00:00Z", "2027-03-01T00:00:00Z").unwrap().into_iter().filter(|e| e.account_id == acc).map(|e| e.subject).collect()
}

fn insert(svc: &MailService, acc: &str, id: &str, start: &str, end: &str) {
    svc.with_account(acc, |db| {
        db.upsert_event(&EventRecord { id: id.into(), calendar_id: webcal::CALENDAR_ID.into(), subject: id.into(), start: start.into(), end: end.into(), ..Default::default() })
    })
    .unwrap();
}

#[test]
fn off_by_default_and_only_for_web_accounts() {
    let (svc, ids, _) = setup();
    let a = svc.get_account(&ids.aldgate).unwrap();
    assert!(!a.web_calendar);
    assert!(svc.store_web_calendar(&ids.aldgate, S, E, &ok(vec![])).is_err(), "reports are refused while the toggle is off");
    assert!(svc.update_account(&ids.coda, &AccountPatch { web_calendar: Some(true), ..Default::default() }).is_err());
    assert!(!svc.get_account(&ids.coda).unwrap().web_calendar);
}

#[test]
fn report_replaces_its_range_keeps_later_events_and_prunes_earlier_ones() {
    let (svc, ids, _) = setup();
    let acc = &ids.aldgate;
    turn_on(&svc, acc);
    svc.store_web_calendar(acc, S, E, &ok(vec![ev("a", "Board prep", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z"), ev("b", "Quarterly review", "2026-11-26T14:00:00Z", "2026-11-26T15:00:00Z")]))
        .unwrap();
    assert_eq!(web_subjects(&svc, acc), vec!["Board prep", "Quarterly review"]);

    insert(&svc, acc, "old", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z");
    insert(&svc, acc, "later", "2027-02-01T10:00:00Z", "2027-02-01T11:00:00Z");
    svc.store_web_calendar(acc, S, E, &ok(vec![ev("b", "Quarterly review (moved)", "2026-11-27T14:00:00Z", "2026-11-27T15:00:00Z")])).unwrap();
    assert_eq!(web_subjects(&svc, acc), vec!["Quarterly review (moved)", "later"], "a is gone, old is pruned, later is kept");

    let a = svc.get_account(acc).unwrap();
    assert!(a.web_calendar_synced_at.is_some());
    assert!(a.web_calendar_error.is_none());
}

#[test]
fn failed_report_keeps_data_and_sets_the_error() {
    let (svc, ids, counts) = setup();
    let acc = &ids.aldgate;
    turn_on(&svc, acc);
    svc.store_web_calendar(acc, S, E, &ok(vec![ev("a", "Board prep", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")])).unwrap();
    let synced = svc.get_account(acc).unwrap().web_calendar_synced_at;
    counts.take();

    svc.store_web_calendar(acc, S, E, &failed("signed_out")).unwrap();
    let a = svc.get_account(acc).unwrap();
    assert_eq!(a.web_calendar_error.as_deref(), Some("signed_out"));
    assert_eq!(a.web_calendar_synced_at, synced, "the last good time is kept");
    assert_eq!(web_subjects(&svc, acc), vec!["Board prep"], "never wipe data on a failed fetch");
    assert_eq!(counts.take(), (0, 1), "the error state changed");

    svc.store_web_calendar(acc, S, E, &failed("signed_out")).unwrap();
    assert_eq!(counts.take(), (0, 0), "same error again: nothing to re-send");

    // A rejected report counts as a failure too.
    let mut wrong = ok(vec![]);
    wrong.end = "2027-03-01T00:00:00Z".into();
    svc.store_web_calendar(acc, S, E, &wrong).unwrap();
    assert_eq!(svc.get_account(acc).unwrap().web_calendar_error.as_deref(), Some("range"));
    assert_eq!(web_subjects(&svc, acc), vec!["Board prep"]);
    let many: Vec<_> = (0..=webcal::MAX_EVENTS).map(|i| ev(&format!("e{i}"), "x", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")).collect();
    svc.store_web_calendar(acc, S, E, &ok(many)).unwrap();
    assert_eq!(svc.get_account(acc).unwrap().web_calendar_error.as_deref(), Some("too_many"));
    assert_eq!(web_subjects(&svc, acc), vec!["Board prep"]);

    svc.store_web_calendar(acc, S, E, &ok(vec![ev("a", "Board prep", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")])).unwrap();
    assert!(svc.get_account(acc).unwrap().web_calendar_error.is_none(), "a later success clears it");
}

#[test]
fn emits_only_when_events_change() {
    let (svc, ids, counts) = setup();
    let acc = &ids.aldgate;
    turn_on(&svc, acc);
    counts.take();
    let r = ok(vec![ev("a", "Board prep", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")]);
    svc.store_web_calendar(acc, S, E, &r).unwrap();
    assert_eq!(counts.take().0, 1, "new events: calendar refresh");
    svc.store_web_calendar(acc, S, E, &r).unwrap();
    assert_eq!(counts.take(), (0, 0), "same events again: no events at all");
}

#[test]
fn listed_read_only_while_on_and_respecting_visibility() {
    let (svc, ids, _) = setup();
    let acc = &ids.aldgate;
    assert!(svc.list_calendars().unwrap().iter().all(|c| &c.account_id != acc));

    turn_on(&svc, acc);
    svc.store_web_calendar(acc, S, E, &ok(vec![ev("a", "Board prep", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")])).unwrap();
    let cal = svc.list_calendars().unwrap().into_iter().find(|c| &c.account_id == acc).unwrap();
    assert!(cal.read_only && cal.is_default && cal.visible);
    assert!(svc.list_calendars().unwrap().iter().filter(|c| &c.account_id != acc).all(|c| !c.read_only), "Graph calendars stay editable");

    let events = svc.list_events(S, E).unwrap();
    let web = events.iter().find(|e| &e.account_id == acc).unwrap();
    assert!(web.read_only);
    assert_eq!(web.color, "#6E7781", "web accounts are neutral grey");
    assert_eq!(web.online_meeting_url.as_deref(), Some("https://teams.microsoft.com/l/meetup-join/1"));
    assert!(events.iter().filter(|e| &e.account_id != acc).all(|e| !e.read_only));

    // Agenda reads list_events.
    let now = Local.with_ymd_and_hms(2026, 11, 23, 9, 50, 0).unwrap();
    let tomorrow = &svc.agenda_at(2, now).unwrap()[1];
    assert!(tomorrow.events.iter().any(|e| e.subject == "Board prep" && e.read_only));

    svc.set_calendar_visible(&cal.id, false).unwrap();
    assert!(web_subjects(&svc, acc).is_empty());
    svc.set_calendar_visible(&cal.id, true).unwrap();
    assert_eq!(web_subjects(&svc, acc), vec!["Board prep"]);
}

#[test]
fn web_events_refuse_changes() {
    let (svc, ids, _) = setup();
    let acc = &ids.aldgate;
    turn_on(&svc, acc);
    let mut invite = ev("a", "Board prep", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z");
    invite["myResponse"] = json!("none");
    svc.store_web_calendar(acc, S, E, &ok(vec![invite])).unwrap();
    let id = format!("{acc}:a");
    let read_only = |r: mail_core::Result<_>| matches!(r, Err(mail_core::Error::Invalid(m)) if m.contains("read-only"));
    assert!(read_only(svc.respond_event(&id, EventResponse::Accepted).map(|_| ())));
    let input = EventInput {
        account_id: acc.clone(),
        calendar_id: None,
        subject: "Changed".into(),
        start: "2026-11-24T10:00:00Z".into(),
        end: "2026-11-24T11:00:00Z".into(),
        is_all_day: false,
        location: String::new(),
        body_html: String::new(),
        attendees: vec![],
        is_online_meeting: false,
        reminder_minutes: None,
    };
    assert!(read_only(svc.update_event(&id, &input).map(|_| ())));
    assert!(read_only(svc.delete_event(&id)));
    assert!(svc.create_event(&input).is_err(), "no new events on web accounts");
    // A Graph account can't target the web calendar either.
    let into_web = EventInput { account_id: ids.coda.clone(), calendar_id: Some(format!("{acc}:{}", webcal::CALENDAR_ID)), ..input };
    assert!(svc.create_event(&into_web).is_err());
    assert_eq!(web_subjects(&svc, acc), vec!["Board prep"]);
    assert!(svc.with_account(acc, |db| db.all_ops()).unwrap().is_empty(), "nothing queued for Graph");
}

#[test]
fn reminders_ignore_web_events() {
    let (svc, ids, _) = setup();
    let acc = &ids.aldgate;
    turn_on(&svc, acc);
    svc.with_account(acc, |db| {
        db.upsert_event(&EventRecord {
            id: "r".into(),
            calendar_id: webcal::CALENDAR_ID.into(),
            subject: "Web reminder".into(),
            start: "2026-11-24T10:00:00Z".into(),
            end: "2026-11-24T11:00:00Z".into(),
            reminder_minutes: Some(15),
            ..Default::default()
        })
    })
    .unwrap();
    let since = Utc.with_ymd_and_hms(2026, 11, 24, 9, 40, 0).unwrap();
    let due = svc.due_reminders(since, since + chrono::Duration::minutes(10)).unwrap();
    assert!(due.iter().all(|e| &e.account_id != acc));
}

#[test]
fn toggle_off_and_upgrade_delete_the_rows() {
    let (svc, ids, _) = setup();
    let acc = &ids.aldgate;
    turn_on(&svc, acc);
    svc.store_web_calendar(acc, S, E, &failed("timeout")).unwrap();
    svc.store_web_calendar(acc, S, E, &ok(vec![ev("a", "Board prep", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")])).unwrap();
    svc.update_account(acc, &AccountPatch { web_calendar: Some(false), ..Default::default() }).unwrap();
    let a = svc.get_account(acc).unwrap();
    assert!(!a.web_calendar && a.web_calendar_synced_at.is_none() && a.web_calendar_error.is_none());
    assert!(svc.with_account(acc, |db| db.list_calendars()).unwrap().is_empty());
    assert!(svc.with_account(acc, |db| db.list_events(S, E, "")).unwrap().is_empty());

    // On again, then the tenant approves the app: Graph takes over.
    turn_on(&svc, acc);
    svc.store_web_calendar(acc, S, E, &ok(vec![ev("a", "Board prep", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")])).unwrap();
    let up = svc.add_graph_account("miles.rowland@aldgatecapital.example", "Aldgate Capital", Some("tid".into()), None).unwrap();
    assert_eq!(up.id, *acc);
    let a = svc.get_account(acc).unwrap();
    assert_eq!(a.kind, AccountKind::Graph);
    assert!(!a.web_calendar && a.web_calendar_synced_at.is_none());
    assert!(svc.with_account(acc, |db| db.list_events(S, E, "")).unwrap().is_empty());
    assert!(svc.list_calendars().unwrap().iter().all(|c| &c.account_id != acc), "no calendars until Graph sync runs");
}
