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
fn signature_added_swapped_and_removed_on_an_existing_draft() {
    let (svc, ids) = setup();
    let sigs = svc.list_signatures(Some(&ids.coda)).unwrap();
    let sig = sigs.first().expect("demo Coda account has a signature").clone();
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(ids.coda.clone()) }).unwrap();
    let cleared = svc.set_draft_signature(&d.id, None).unwrap();
    assert!(!cleared.body_html.contains("data-signature"), "signature removed");
    assert_eq!(cleared.signature_id, None);
    assert_eq!(cleared.id, d.id, "the draft stays put");

    let added = svc.set_draft_signature(&d.id, Some(&sig.id)).unwrap();
    assert_eq!(added.body_html.matches("data-signature").count(), 1, "signature added once");
    assert_eq!(added.signature_id.as_deref(), Some(sig.id.as_str()));
    let again = svc.set_draft_signature(&d.id, Some(&sig.id)).unwrap();
    assert_eq!(again.body_html.matches("data-signature").count(), 1, "picking it again doesn't duplicate it");
    assert_eq!(svc.get_draft(&d.id).unwrap().signature_id.as_deref(), Some(sig.id.as_str()));
    assert!(ops(&svc, &ids.coda).contains(&"saveDraft".to_string()));

    let other = svc.list_signatures(Some(&ids.harbour)).unwrap();
    if let Some(foreign) = other.first() {
        assert!(svc.set_draft_signature(&d.id, Some(&foreign.id)).is_err(), "another account's signature is refused");
    }
    assert!(svc.set_draft_signature(&d.id, Some("nope")).is_err());
}

#[test]
fn inbox_rows_show_an_unfinished_draft() {
    let (svc, ids) = setup();
    let src = format!("{}:m-agenda", ids.harbour);
    let has_draft = || svc.list_messages(&ViewScope::unified_inbox(), 50, 0).unwrap().into_iter().find(|m| m.id == src).unwrap().has_draft;
    assert!(!has_draft());

    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::Reply, source_message_id: Some(src.clone()), account_id: None }).unwrap();
    assert!(!has_draft(), "opening Reply without typing doesn't count");

    let mut edit = d.clone();
    edit.body_html = format!("<p>Happy to</p>{}", d.body_html);
    let d = svc.update_draft(&edit).unwrap();
    assert!(has_draft());

    svc.send_draft(&d.id).unwrap();
    assert!(!has_draft(), "a queued send is no longer a draft to finish");

    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::Forward, source_message_id: Some(src.clone()), account_id: None }).unwrap();
    let d = svc.update_draft(&d).unwrap();
    assert!(has_draft());
    svc.discard_draft(&d.id).unwrap();
    assert!(!has_draft());
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
    let q = |text: &str| SearchQuery { text: text.into(), scope: ViewScope::unified_inbox(), all_folders: false, from: None, to: None, has_attachment: None, unread: None, date: None, account_id: None, field: SearchField::All };
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
    // By field: the sender's name finds their mail; the subject field doesn't look at senders.
    let mut sender = q("okafor");
    sender.field = SearchField::From;
    let r = svc.search(&sender).unwrap();
    assert!(r.total > 0 && r.messages.iter().all(|m| m.from.name == "Sarah Okafor"));
    sender.field = SearchField::Subject;
    assert_eq!(svc.search(&sender).unwrap().total, 0);
    // A superseded search stops.
    assert!(svc.search_unless(&q("steering"), || true).is_err());
}

#[test]
fn search_events_by_title_place_and_people() {
    let (svc, _) = setup();
    let find = |q: EventQuery| svc.search_events(&q).unwrap().into_iter().map(|e| e.subject).collect::<Vec<_>>();
    let subjects = |text: &str| find(EventQuery { text: text.into(), ..Default::default() });
    assert_eq!(subjects("steering"), vec!["Steering committee"]);
    assert_eq!(subjects("3rd floor"), vec!["Steering committee"]);
    // Organizer or attendee, by name or address; latest first.
    assert_eq!(subjects("okafor"), vec!["Debrief", "Steering committee", "Portfolio scan check-in"]);
    assert_eq!(subjects("priya.nair@"), vec!["Warehouse design session", "Data review"]);
    // JSON keys and LIKE wildcards don't match.
    assert!(subjects("email").is_empty());
    assert!(subjects("%").is_empty());
    assert!(subjects("  ").is_empty());
    // By field.
    assert!(find(EventQuery { text: "okafor".into(), field: EventField::Title, ..Default::default() }).is_empty());
    assert_eq!(find(EventQuery { text: "debrief".into(), field: EventField::Title, ..Default::default() }), vec!["Debrief"]);
    assert_eq!(find(EventQuery { text: "priya".into(), field: EventField::People, ..Default::default() }).len(), 2);
    assert!(find(EventQuery { text: "floor".into(), field: EventField::People, ..Default::default() }).is_empty());
    // By date, with or without words.
    let steering = svc.search_events(&EventQuery { text: "steering".into(), ..Default::default() }).unwrap().remove(0);
    let before_it = EventQuery { text: "okafor".into(), before: Some(steering.start.clone()), ..Default::default() };
    assert_eq!(find(before_it), vec!["Portfolio scan check-in"]);
    let after_it = EventQuery { after: Some(steering.end.clone()), field: EventField::Title, ..Default::default() };
    assert!(find(after_it.clone()).contains(&"Debrief".to_string()));
    assert!(!find(after_it).contains(&"Steering committee".to_string()));
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
fn sending_moves_a_draft_from_drafts_to_the_outbox() {
    let (svc, ids) = setup();
    let drafts = ViewScope { account_id: Some(ids.coda.clone()), folder: FolderSelector::Role { role: FolderRole::Drafts }, tab: ListTab::All };
    let outbox = ViewScope { tab: ListTab::Outbox, ..drafts.clone() };
    let counts = || {
        let f = svc.list_folders(Some(&ids.coda)).unwrap().into_iter().find(|f| f.role == Some(FolderRole::Drafts)).unwrap();
        (f.unread, f.outbox)
    };
    let (drafts_before, _) = counts();
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(ids.coda.clone()) }).unwrap();
    let mut e = d.clone();
    e.to = vec![Address::new("Tom", "tom@coda.example")];
    let d = svc.update_draft(&e).unwrap();
    assert!(svc.list_messages(&drafts, 50, 0).unwrap().iter().any(|m| m.id == d.id));
    assert_eq!(counts(), (drafts_before + 1, 0));

    svc.send_draft(&d.id).unwrap();
    assert!(!svc.list_messages(&drafts, 50, 0).unwrap().iter().any(|m| m.id == d.id), "sent: out of Drafts");
    assert_eq!(svc.list_messages(&outbox, 50, 0).unwrap().iter().map(|m| m.id.clone()).collect::<Vec<_>>(), vec![d.id.clone()]);
    assert_eq!(counts(), (drafts_before, 1));

    // Edit takes it back to Drafts and it won't be sent.
    let back = svc.cancel_send(&d.id).unwrap();
    assert_eq!(back.status, DraftStatus::Editing);
    assert!(svc.list_messages(&outbox, 50, 0).unwrap().is_empty());
    assert!(svc.list_messages(&drafts, 50, 0).unwrap().iter().any(|m| m.id == d.id));
    assert_eq!(ops(&svc, &ids.coda).iter().filter(|k| *k == "send").count(), 0, "the queued send is withdrawn");

    // Not once it's actually going out.
    svc.send_draft(&d.id).unwrap();
    let (_, raw) = mail_core::ids::split(&d.id).unwrap();
    assert!(svc.with_account(&ids.coda, |db| db.claim_draft_for_send(raw)).unwrap());
    assert!(svc.cancel_send(&d.id).is_err());
    assert!(!svc.with_account(&ids.coda, |db| db.claim_draft_for_send(raw)).unwrap(), "claimed once");
}

#[test]
fn a_drafts_server_copy_opens_that_draft_not_a_duplicate() {
    let (svc, ids) = setup();
    let src = format!("{}:m-agenda", ids.harbour);
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::Reply, source_message_id: Some(src.clone()), account_id: None }).unwrap();
    let mut e = d.clone();
    e.body_html = format!("<p>Sounds great</p>{}", d.body_html);
    let d = svc.update_draft(&e).unwrap();
    let (_, raw) = mail_core::ids::split(&d.id).unwrap();
    // Saved to the server, and its server copy synced back in as a message (e.g. found by search).
    svc.with_account(&ids.harbour, |db| db.set_draft_server_id(raw, "srv-reply")).unwrap();
    let conv = svc.get_message(&src).unwrap().summary.conversation_id;
    svc.store_messages(
        &ids.harbour,
        &[mail_core::db::account::MessageRecord {
            id: "srv-reply".into(),
            folder_id: "drafts".into(),
            conversation_id: conv,
            subject: d.subject.clone(),
            body_html: Some("<p>Sounds great</p>".into()),
            received_at: "2026-11-22T10:00:00Z".into(),
            is_draft: true,
            ..Default::default()
        }],
    )
    .unwrap();
    let opened = svc.get_draft(&format!("{}:srv-reply", ids.harbour)).unwrap();
    assert_eq!(opened.id, d.id, "the draft we already have");
    let count = svc.with_account(&ids.harbour, |db| Ok(db.list_drafts()?.len())).unwrap();
    assert_eq!(count, 1, "no second copy");
}

#[test]
fn copies_left_by_an_earlier_send_are_cleaned_up() {
    let (svc, ids) = setup();
    // A duplicate adopted from a server draft that has since been sent: no server copy remains.
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(ids.coda.clone()) }).unwrap();
    let (_, raw) = mail_core::ids::split(&d.id).unwrap();
    svc.with_account(&ids.coda, |db| {
        let (mut stray, _) = db.get_draft(raw)?;
        stray.edited = true;
        stray.saved_to_server = true;
        db.save_draft("srv-gone", &stray, None, "user")?;
        db.set_draft_server_id("srv-gone", "srv-gone")
    })
    .unwrap();
    // One whose server copy is still there stays (a draft made in Outlook, opened here).
    svc.store_messages(
        &ids.coda,
        &[mail_core::db::account::MessageRecord { id: "srv-live".into(), folder_id: "drafts".into(), conversation_id: "c-live".into(), received_at: "2026-11-22T10:00:00Z".into(), is_draft: true, ..Default::default() }],
    )
    .unwrap();
    svc.get_draft(&format!("{}:srv-live", ids.coda)).unwrap();
    let dropped = svc.with_account(&ids.coda, |db| db.drop_orphaned_adopted_drafts()).unwrap();
    assert_eq!(dropped, 1);
    let left: Vec<String> = svc.with_account(&ids.coda, |db| Ok(db.list_drafts()?.into_iter().map(|d| d.id).collect())).unwrap();
    assert!(left.iter().any(|id| id.ends_with("srv-live")));
    assert!(!left.iter().any(|id| id.ends_with("srv-gone")));
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

#[test]
fn dropped_files_are_kept_and_attached() {
    let (svc, ids) = setup();
    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(ids.coda.clone()) }).unwrap();
    let d = svc.add_attachment_bytes(&d.id, "Q4 plan: draft?.pdf", b"%PDF-1.4 hello").unwrap();
    let a = &d.attachments[0];
    assert_eq!(a.name, "Q4 plan_ draft_.pdf", "unsafe characters are replaced");
    assert_eq!(a.size, 14);
    assert_eq!(a.content_type, "application/pdf");
    let path = a.local_path.as_deref().unwrap();
    assert!(path.contains("outgoing"), "kept outside the pruned download cache: {path}");
    assert_eq!(std::fs::read(path).unwrap(), b"%PDF-1.4 hello");
    assert!(ops(&svc, &ids.coda).iter().any(|k| k == "saveDraft"));
}

fn new_draft(svc: &MailService, acc: &str) -> Draft {
    svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(acc.to_string()) }).unwrap()
}

fn dropped_path(d: &Draft, i: usize) -> std::path::PathBuf {
    std::path::PathBuf::from(d.attachments[i].local_path.clone().unwrap())
}

#[test]
fn discarding_a_draft_deletes_its_dropped_copies_only() {
    let (svc, ids) = setup();
    // A file picked with Attach is the person's own: never deleted.
    let own = std::env::temp_dir().join(format!("mail-own-{}.txt", std::process::id()));
    std::fs::write(&own, b"mine").unwrap();
    let d = new_draft(&svc, &ids.coda);
    svc.add_attachment(&d.id, &own).unwrap();
    let d = svc.add_attachment_bytes(&d.id, "dropped.txt", b"copy").unwrap();
    let copy = dropped_path(&d, 1);
    assert!(copy.exists());

    svc.discard_draft(&d.id).unwrap();
    assert!(!copy.exists(), "copy deleted");
    assert!(!copy.parent().unwrap().exists(), "its folder too");
    assert!(own.exists(), "picked file left alone");
    std::fs::remove_file(own).unwrap();
}

#[test]
fn removing_a_dropped_attachment_deletes_its_copy() {
    let (svc, ids) = setup();
    let d = new_draft(&svc, &ids.coda);
    svc.add_attachment_bytes(&d.id, "a.txt", b"a").unwrap();
    let d = svc.add_attachment_bytes(&d.id, "b.txt", b"b").unwrap();
    let (a, b) = (dropped_path(&d, 0), dropped_path(&d, 1));
    let d = svc.remove_attachment(&d.id, &d.attachments[0].id.clone()).unwrap();
    assert!(!a.exists());
    assert!(b.exists(), "the other copy stays");
    assert_eq!(d.attachments.len(), 1);
}
