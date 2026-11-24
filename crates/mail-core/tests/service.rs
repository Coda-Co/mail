//! The local service over the demo data.

use chrono::{Local, TimeZone};
use mail_core::demo;
use mail_core::model::*;
use mail_core::ops::Op;
use mail_core::MailService;

fn setup() -> (MailService, demo::DemoIds) {
    let svc = MailService::in_memory().unwrap();
    // Monday 23 November 2026, 09:50 — the mockups' "now".
    let now = Local.with_ymd_and_hms(2026, 11, 23, 9, 50, 0).unwrap();
    let ids = demo::seed_at(&svc, now).unwrap();
    (svc, ids)
}

fn ops(svc: &MailService, acc: &str) -> Vec<String> {
    svc.with_account(acc, |db| Ok(db.all_ops()?.into_iter().map(|o| o.kind).collect())).unwrap()
}

#[test]
fn unified_inbox_and_counts() {
    let (svc, ids) = setup();
    let list = svc.list_messages(&ViewScope::unified_inbox(), 50, 0).unwrap();
    let subjects: Vec<&str> = list.iter().map(|m| m.subject.as_str()).collect();
    assert_eq!(&subjects[..4], &["Agenda for Thursday’s steering committee", "November invoice draft", "Data warehouse access request", "3 issues assigned to you"]);
    assert!(list.iter().all(|m| m.account_id != ids.aldgate), "web accounts are never in the unified inbox");

    let accounts = svc.list_accounts().unwrap();
    let unread: Vec<(String, Option<i64>)> = accounts.iter().map(|a| (a.display_name.clone(), a.unread)).collect();
    assert_eq!(unread, vec![("Coda & Co".into(), Some(1)), ("Harbour Partners".into(), Some(1)), ("Fenwick Group".into(), Some(1)), ("Aldgate Capital".into(), Some(2))]);

    let unread_tab = svc.list_messages(&ViewScope { tab: ListTab::Unread, ..ViewScope::unified_inbox() }, 50, 0).unwrap();
    assert_eq!(unread_tab.len(), 3);
    let folders = svc.list_folders(None).unwrap();
    assert_eq!(folders[0].id, "all:inbox");
    assert_eq!(folders[0].unread, 3);
    // Paging
    let page2 = svc.list_messages(&ViewScope::unified_inbox(), 2, 2).unwrap();
    assert_eq!(page2[0].subject, "Data warehouse access request");
}

#[test]
fn actions_apply_locally_and_queue() {
    let (svc, ids) = setup();
    let id = format!("{}:m-agenda", ids.harbour);
    svc.mark_read(std::slice::from_ref(&id), true).unwrap();
    assert!(svc.get_message(&id).unwrap().summary.is_read);
    svc.archive(std::slice::from_ref(&id)).unwrap();
    let inbox = svc.list_messages(&ViewScope::unified_inbox(), 50, 0).unwrap();
    assert!(!inbox.iter().any(|m| m.id == id));
    svc.delete_messages(std::slice::from_ref(&id)).unwrap();
    svc.delete_messages(std::slice::from_ref(&id)).unwrap(); // second delete from Deleted is permanent
    assert!(svc.get_message(&id).is_err());
    assert_eq!(ops(&svc, &ids.harbour), vec!["markRead", "move", "move", "deleteMessages"]);
    let payloads = svc.with_account(&ids.harbour, |db| db.all_ops()).unwrap();
    let archive: Op = serde_json::from_value(payloads[1].payload.clone()).unwrap();
    assert_eq!(archive, Op::Move { ids: vec!["m-agenda".into()], destination: "archive".into() });
}

#[test]
fn reply_draft_defaults_and_from_swap() {
    let (svc, ids) = setup();
    let src = format!("{}:m-agenda", ids.harbour);
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::Reply, source_message_id: Some(src.clone()), account_id: None }).unwrap();
    assert_eq!(d.account_id, ids.harbour, "From defaults to the account the message came in on");
    assert_eq!(d.to, vec![Address::new("Sarah Okafor", "sarah.okafor@harbourpartners.example")]);
    assert_eq!(d.subject, "RE: Agenda for Thursday’s steering committee");
    assert!(d.body_html.contains("data-signature"), "reply signature inserted");
    assert!(d.body_html.contains("<div>Miles</div>"));
    assert!(!d.body_html.contains("data-quote"), "the quote stays out of the editor");
    let (_, raw) = mail_core::ids::split(&d.id).unwrap();
    let quote = svc.with_account(&ids.harbour, |db| db.draft_quote(raw)).unwrap().unwrap();
    assert!(quote.contains("AI roadmap item") && quote.contains("Sarah Okafor ·"));

    let thread = svc.get_thread(&src).unwrap();
    assert_eq!(thread.drafts.len(), 1, "draft sits in the conversation");

    let swapped = svc.change_draft_account(&d.id, &ids.coda).unwrap();
    assert_eq!(swapped.account_id, ids.coda);
    assert!(swapped.id.starts_with(&ids.coda));
    assert_eq!(swapped.body_html.matches("data-signature").count(), 1);
    let (_, raw2) = mail_core::ids::split(&swapped.id).unwrap();
    assert!(svc.with_account(&ids.coda, |db| db.draft_quote(raw2)).unwrap().is_some(), "quote moves with the draft");
    assert!(svc.get_draft(&d.id).is_err());

    let reply_all = svc.create_draft(&CreateDraftRequest { mode: DraftMode::ReplyAll, source_message_id: Some(format!("{}:m-moved", ids.harbour)), account_id: None }).unwrap();
    let to: Vec<&str> = reply_all.to.iter().map(|a| a.email.as_str()).collect();
    assert_eq!(to, vec!["sarah.okafor@harbourpartners.example", "james.hart@harbourpartners.example"], "reply all leaves me out");
}

#[test]
fn outbox_rules() {
    let (svc, ids) = setup();
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(ids.coda.clone()) }).unwrap();
    assert!(d.body_html.contains("coda.example"), "new-message signature");
    assert!(svc.send_draft(&d.id).is_err(), "needs a recipient");
    let mut edit = d.clone();
    edit.to = vec![Address::new("Tom", "not-an-address")];
    let edit = svc.update_draft(&edit).unwrap();
    assert!(svc.send_draft(&edit.id).is_err());
    let mut edit = edit;
    edit.to = vec![Address::new("Tom", "tom@coda.example")];
    let edit = svc.update_draft(&edit).unwrap();
    let queued = svc.send_draft(&edit.id).unwrap();
    assert_eq!(queued.status, DraftStatus::Queued);
    assert!(svc.update_draft(&queued).is_err(), "queued drafts are locked");
    assert!(svc.send_draft(&queued.id).is_err(), "no double queueing");
    assert!(svc.discard_draft(&queued.id).is_err());
    assert_eq!(ops(&svc, &ids.coda).iter().filter(|k| *k == "send").count(), 1);
    // Web accounts can't compose here.
    assert!(svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(ids.aldgate.clone()) }).is_err());
}

#[test]
fn search_filters_the_view() {
    let (svc, ids) = setup();
    let q = |text: &str| SearchQuery { text: text.into(), scope: ViewScope::unified_inbox(), all_folders: false, from: None, to: None, has_attachment: None, unread: None, date: None, account_id: None };
    let r = svc.search(&q("steering")).unwrap();
    assert_eq!(r.total, 3);
    let mut from = q("steering");
    from.from = Some("SARAH.okafor@harbourpartners.example".into());
    let r = svc.search(&from).unwrap();
    assert_eq!(r.messages.len(), 3);
    let card = r.contact.unwrap();
    assert_eq!(card.name, "Sarah Okafor");
    assert_eq!(card.account_ids, vec![ids.harbour.clone()]);
    let mut att = from.clone();
    att.has_attachment = Some(true);
    assert_eq!(svc.search(&att).unwrap().messages.len(), 2);
    let mut unread = q("");
    unread.unread = Some(true);
    assert_eq!(svc.search(&unread).unwrap().total, 3);
    let mut acct = q("");
    acct.account_id = Some(ids.coda.clone());
    assert!(svc.search(&acct).unwrap().messages.iter().all(|m| m.account_id == ids.coda));
    // Sent is outside "In: Inbox" until widened.
    let mut sent = q("Tuesday");
    assert_eq!(svc.search(&sent).unwrap().total, 0);
    sent.all_folders = true;
    assert_eq!(svc.search(&sent).unwrap().total, 1);
    let mut to = q("");
    to.to = Some("elena@marsh.example".into());
    to.all_folders = true;
    assert_eq!(svc.search(&to).unwrap().total, 1);
}

#[test]
fn people_ranked() {
    let (svc, _) = setup();
    let people = svc.list_people("", 10).unwrap();
    // Elena: one received and one I wrote (outgoing counts double). Sarah: three received.
    let top: Vec<&str> = people.iter().take(2).map(|p| p.name.as_str()).collect();
    assert_eq!(top, vec!["Elena Marsh", "Sarah Okafor"]);
    assert_eq!(people[1].message_count, 3);
    assert!(!people.iter().any(|p| p.email.contains("coda.example") && p.name == "Miles Rowland"), "my own addresses are excluded");
    assert_eq!(svc.list_people("pri", 5).unwrap()[0].name, "Priya Nair");
}

#[test]
fn agenda_and_calendar() {
    let (svc, ids) = setup();
    let now = Local.with_ymd_and_hms(2026, 11, 23, 9, 50, 0).unwrap();
    let days = svc.agenda_at(5, now).unwrap();
    let labels: Vec<&str> = days.iter().map(|d| d.label.as_str()).collect();
    assert_eq!(labels, vec!["Today", "Tomorrow", "Wednesday", "Thursday", "Friday"]);
    // Weekly delivery (09:00–09:30) is over; the rest of today remains.
    let today: Vec<&str> = days[0].events.iter().map(|e| e.subject.as_str()).collect();
    assert_eq!(today, vec!["Client workshop prep", "Data review"]);
    assert_eq!(days[3].events[0].subject, "Steering committee");
    assert_eq!(days[3].events[0].color, "#8250DF");

    let harbour_cal = svc.list_calendars().unwrap().into_iter().find(|c| c.account_id == ids.harbour).unwrap();
    svc.set_calendar_visible(&harbour_cal.id, false).unwrap();
    let days = svc.agenda_at(5, now).unwrap();
    assert!(days[3].events.is_empty());
    svc.set_calendar_visible(&harbour_cal.id, true).unwrap();

    let steering = days_event(&svc, now, "Steering committee");
    let resp = svc.respond_event(&steering, EventResponse::Tentative).unwrap();
    assert_eq!(resp.my_response, ResponseStatus::Tentative);

    let created = svc
        .create_event(&EventInput {
            account_id: ids.coda.clone(),
            calendar_id: None,
            subject: "Planning".into(),
            start: "2026-11-24T13:00:00Z".into(),
            end: "2026-11-24T14:00:00Z".into(),
            is_all_day: false,
            location: "Teams".into(),
            body_html: String::new(),
            attendees: vec![Address::new("Tom", "tom@coda.example")],
            is_online_meeting: true,
            reminder_minutes: None,
        })
        .unwrap();
    assert_eq!(created.my_response, ResponseStatus::Organizer);
    assert!(ops(&svc, &ids.coda).contains(&"createEvent".to_string()));
    svc.delete_event(&created.id).unwrap();
    assert!(!ops(&svc, &ids.coda).contains(&"createEvent".to_string()), "a never-synced event just disappears");

    let bad = svc.create_event(&EventInput {
        account_id: ids.coda.clone(),
        calendar_id: None,
        subject: "Backwards".into(),
        start: "2026-11-24T14:00:00Z".into(),
        end: "2026-11-24T13:00:00Z".into(),
        is_all_day: false,
        location: String::new(),
        body_html: String::new(),
        attendees: vec![],
        is_online_meeting: false,
        reminder_minutes: None,
    });
    assert!(bad.is_err());
}

fn days_event(svc: &MailService, now: chrono::DateTime<Local>, subject: &str) -> String {
    svc.agenda_at(7, now).unwrap().into_iter().flat_map(|d| d.events).find(|e| e.subject == subject).unwrap().id
}

#[test]
fn reminders_fire_once_in_window() {
    let (svc, _) = setup();
    let start: chrono::DateTime<chrono::Utc> = Local.with_ymd_and_hms(2026, 11, 23, 10, 40, 0).unwrap().with_timezone(&chrono::Utc);
    // Client workshop prep at 11:00 with a 15-minute reminder → 10:45.
    let due = svc.due_reminders(start, start + chrono::Duration::minutes(6)).unwrap();
    assert_eq!(due.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), vec!["Client workshop prep"]);
    let later = svc.due_reminders(start + chrono::Duration::minutes(6), start + chrono::Duration::minutes(10)).unwrap();
    assert!(later.is_empty());
}

fn store_image_mail(svc: &MailService, account: &str, id: &str, folder: &str) -> String {
    svc.store_messages(
        account,
        &[mail_core::db::account::MessageRecord {
            id: id.into(),
            folder_id: folder.into(),
            conversation_id: format!("c-{id}"),
            from: Address::new("News", "news@letter.example"),
            subject: "Pictures".into(),
            body_html: Some("<p>Hi</p><img src=\"https://letter.example/pixel.gif\">".into()),
            received_at: "2026-11-20T10:00:00Z".into(),
            ..Default::default()
        }],
    )
    .unwrap();
    format!("{account}:{id}")
}

#[test]
fn remote_images_show_by_default_except_in_junk() {
    let (svc, ids) = setup();
    assert_eq!(svc.settings().unwrap().remote_images, "show");
    let inbox = store_image_mail(&svc, &ids.coda, "m-img", "inbox");
    let m = svc.get_message(&inbox).unwrap();
    assert!(!m.remote_images_blocked);
    assert!(m.body_html.contains("pixel.gif"));

    svc.with_account(&ids.coda, |db| db.upsert_folder("junk", "Junk Email", Some(FolderRole::Junk), None, 0)).unwrap();
    let junk = store_image_mail(&svc, &ids.coda, "m-junk", "junk");
    let m = svc.get_message(&junk).unwrap();
    assert!(m.remote_images_blocked, "Junk stays blocked");
    assert!(!m.body_html.contains("pixel.gif"));
    assert!(svc.show_remote_images_once(&junk).unwrap().body_html.contains("pixel.gif"));
    svc.allow_remote_images("news@letter.example").unwrap();
    assert!(!svc.get_message(&junk).unwrap().remote_images_blocked, "an allowed sender loads even in Junk");
}

#[test]
fn settings_saved_before_remote_images_existed_still_load() {
    let svc = MailService::in_memory().unwrap();
    svc.app().kv_set("app", r#"{"theme":"dark","notifications":false,"ctrlF":"find","mcpEnabled":false,"mcpAllowSend":false,"remoteImageSenders":["a@b.example"]}"#).unwrap();
    let s = svc.settings().unwrap();
    assert_eq!(s.theme, "dark", "older settings kept, not reset");
    assert_eq!(s.remote_images, "show");
    assert!(svc.update_settings(&SettingsPatch { remote_images: Some("never".into()), ..Default::default() }).is_err());
}

#[test]
fn remote_images_per_sender() {
    let (svc, ids) = setup();
    svc.update_settings(&SettingsPatch { remote_images: Some("ask".into()), ..Default::default() }).unwrap();
    let id = store_image_mail(&svc, &ids.coda, "m-img", "inbox");
    let m = svc.get_message(&id).unwrap();
    assert!(m.remote_images_blocked);
    assert!(!m.body_html.contains("pixel.gif"));
    assert!(svc.show_remote_images_once(&id).unwrap().body_html.contains("pixel.gif"));
    assert!(svc.get_message(&id).unwrap().remote_images_blocked);
    svc.allow_remote_images("News@Letter.example").unwrap();
    assert!(!svc.get_message(&id).unwrap().remote_images_blocked);
}

#[test]
fn remove_account_cleans_up() {
    let (svc, ids) = setup();
    svc.remove_account(&ids.fenwick).unwrap();
    assert_eq!(svc.list_accounts().unwrap().len(), 3);
    assert!(svc.list_messages(&ViewScope::unified_inbox(), 50, 0).unwrap().iter().all(|m| m.account_id != ids.fenwick));
}

#[test]
fn drafts_folder_lists_by_draft_id() {
    let (svc, ids) = setup();
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::Reply, source_message_id: Some(format!("{}:m-agenda", ids.harbour)), account_id: None }).unwrap();
    let mut e = d.clone();
    e.body_html = format!("<div>Happy to take it.</div>{}", &d.body_html[d.body_html.find("<div data-signature").unwrap()..]);
    svc.update_draft(&e).unwrap();
    let scope = ViewScope { account_id: None, folder: FolderSelector::Role { role: FolderRole::Drafts }, tab: ListTab::All };
    let list = svc.list_messages(&scope, 50, 0).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, d.id);
    assert!(list[0].is_draft);
    assert_eq!(list[0].snippet, "Happy to take it.");
    // A draft made in Outlook arrives as a message and is adopted on open.
    svc.store_messages(
        &ids.coda,
        &[mail_core::db::account::MessageRecord {
            id: "srv-draft".into(),
            folder_id: "drafts".into(),
            conversation_id: "c-x".into(),
            subject: "From Outlook".into(),
            body_html: Some("<p>typed elsewhere</p>".into()),
            received_at: "2026-11-22T10:00:00Z".into(),
            is_draft: true,
            ..Default::default()
        }],
    )
    .unwrap();
    let list = svc.list_messages(&scope, 50, 0).unwrap();
    assert_eq!(list.len(), 2);
    let adopted = svc.get_draft(&format!("{}:srv-draft", ids.coda)).unwrap();
    assert_eq!(adopted.subject, "From Outlook");
    assert_eq!(svc.list_messages(&scope, 50, 0).unwrap().len(), 2, "no duplicate after adopting");
}

#[test]
fn sent_drafts_leave_the_thread_held_ones_stay() {
    let (svc, ids) = setup();
    let src = format!("{}:m-agenda", ids.harbour);
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::Reply, source_message_id: Some(src.clone()), account_id: None }).unwrap();
    svc.send_draft(&d.id).unwrap();
    assert!(svc.get_thread(&src).unwrap().drafts.is_empty(), "queued drafts are in the outbox, not the editor");
    let (_, raw) = mail_core::ids::split(&d.id).unwrap();
    svc.with_account(&ids.harbour, |db| db.set_draft_status(raw, DraftStatus::Unknown, Some("check Sent"))).unwrap();
    let t = svc.get_thread(&src).unwrap();
    assert_eq!(t.drafts.len(), 1);
    assert_eq!(t.drafts[0].status, DraftStatus::Unknown);
}

#[test]
fn new_drafts_are_unedited_until_changed() {
    let (svc, ids) = setup();
    let src = format!("{}:m-agenda", ids.harbour);
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::Reply, source_message_id: Some(src), account_id: None }).unwrap();
    assert!(!d.edited, "a fresh reply is unedited");
    assert!(!svc.get_draft(&d.id).unwrap().edited, "stored as unedited");
    assert!(!svc.set_popped_out(&d.id, true).unwrap().edited, "popping out isn't an edit");

    let mut changed = svc.get_draft(&d.id).unwrap();
    changed.body_html = "<p>Thanks</p>".into();
    assert!(svc.update_draft(&changed).unwrap().edited);
    assert!(svc.get_draft(&d.id).unwrap().edited, "stays edited once saved");
}
