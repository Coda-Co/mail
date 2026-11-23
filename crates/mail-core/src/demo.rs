//! Sample data from the mockups (all names made up). Used by `MAIL_APP_DEMO=1`,
//! the MCP server's tests and screenshots. Times are relative to `now`.

use crate::db::account::{EventRecord, MessageRecord};
use crate::error::Result;
use crate::model::*;
use crate::service::MailService;
use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Utc};

fn at(now: DateTime<Local>, days_ago: i64, h: u32, m: u32) -> String {
    let d = (now - Duration::days(days_ago)).date_naive().and_hms_opt(h, m, 0).unwrap();
    Local.from_local_datetime(&d).earliest().unwrap().with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn ev_at(monday: chrono::NaiveDate, day: i64, h: u32, m: u32) -> String {
    let d = (monday + Duration::days(day)).and_hms_opt(h, m, 0).unwrap();
    Local.from_local_datetime(&d).earliest().unwrap().with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub struct DemoIds {
    pub coda: String,
    pub harbour: String,
    pub fenwick: String,
    pub aldgate: String,
}

pub fn seed(svc: &MailService) -> Result<DemoIds> {
    seed_at(svc, Local::now())
}

pub fn seed_at(svc: &MailService, now: DateTime<Local>) -> Result<DemoIds> {
    let coda = svc.add_graph_account("miles@coda.example", "Coda & Co", Some("t-coda".into()), None)?;
    let harbour = svc.add_graph_account("miles.rowland@harbourpartners.example", "Harbour Partners", Some("t-harbour".into()), None)?;
    let fenwick = svc.add_graph_account("m.rowland@fenwick.example", "Fenwick Group", Some("t-fenwick".into()), None)?;
    let aldgate = svc.add_web_account("miles.rowland@aldgatecapital.example", "Aldgate Capital")?;
    svc.set_web_unread(&aldgate.id, Some(2))?;
    svc.set_me(&Me { name: "Miles Rowland".into(), email: "miles@coda.example".into() })?;

    for a in [&coda, &harbour, &fenwick] {
        svc.with_account(&a.id, |db| {
            for (id, name, role) in [
                ("inbox", "Inbox", FolderRole::Inbox),
                ("drafts", "Drafts", FolderRole::Drafts),
                ("sent", "Sent", FolderRole::Sent),
                ("archive", "Archive", FolderRole::Archive),
                ("deleted", "Deleted", FolderRole::Deleted),
            ] {
                db.upsert_folder(id, name, Some(role), None, 0)?;
            }
            db.upsert_calendar("cal", "Calendar", true, true)
        })?;
    }

    let me = |a: &Account| Address::new("Miles Rowland", a.email.clone());
    let sarah = Address::new("Sarah Okafor", "sarah.okafor@harbourpartners.example");
    let james = Address::new("James Hart", "james.hart@harbourpartners.example");
    let tom = Address::new("Tom Reid", "tom@coda.example");
    let priya = Address::new("Priya Nair", "priya.nair@fenwick.example");
    let linear = Address::new("Linear", "notifications@linear.example");
    let elena = Address::new("Elena Marsh", "elena@marsh.example");

    let msg = |id: &str, folder: &str, from: &Address, to: Vec<Address>, subject: &str, body: &str, received: String, read: bool, attach: bool, conv: &str| MessageRecord {
        id: id.into(),
        folder_id: folder.into(),
        conversation_id: conv.into(),
        from: from.clone(),
        to,
        subject: subject.into(),
        snippet: crate::text::snippet(body, 200),
        body_html: Some(crate::text::text_to_html(body)),
        received_at: received,
        is_read: read,
        has_attachments: attach,
        ..Default::default()
    };

    svc.store_messages(
        &harbour.id,
        &[
            msg(
                "m-agenda",
                "inbox",
                &sarah,
                vec![me(&harbour)],
                "Agenda for Thursday’s steering committee",
                "Hi Miles,\n\nAttaching the draft agenda for Thursday. Could you take the AI roadmap item? Twenty minutes should be plenty, with time for questions at the end.\n\nWe’ll be in the large meeting room on the third floor; I’ll send dial-in details for anyone joining remotely.\n\nThanks,\nSarah",
                at(now, 0, 9, 42),
                false,
                true,
                "conv-agenda",
            ),
            msg("m-portfolio", "inbox", &james, vec![me(&harbour)], "Re: Portfolio scan next steps", "Agree with the shortlist. Let’s pick it up on Thursday.\n\nJames", at(now, 1, 16, 5), true, false, "conv-portfolio"),
            msg(
                "m-moved",
                "inbox",
                &sarah,
                vec![me(&harbour), james.clone()],
                "Steering committee: date moved",
                "We’ve moved the November steering committee to Thursday 26th, same time. Calendar invite to follow.\n\nSarah",
                at(now, 11, 14, 20),
                true,
                false,
                "conv-moved",
            ),
            msg("m-pack", "inbox", &sarah, vec![me(&harbour)], "October steering pack", "Pack attached for reference ahead of the session.\n\nSarah", at(now, 25, 10, 0), true, true, "conv-pack"),
        ],
    )?;
    svc.with_account(&harbour.id, |db| {
        db.replace_attachments(
            "m-agenda",
            &[Attachment { id: "a1".into(), name: "Steering committee agenda.docx".into(), content_type: crate::service::guess_mime("x.docx").into(), size: 48_213, is_inline: false, content_id: None, local_path: None }],
        )?;
        db.replace_attachments(
            "m-pack",
            &[Attachment { id: "a2".into(), name: "October steering pack.pdf".into(), content_type: "application/pdf".into(), size: 1_204_000, is_inline: false, content_id: None, local_path: None }],
        )
    })?;
    svc.store_messages(
        &coda.id,
        &[
            msg("m-invoice", "inbox", &tom, vec![me(&coda)], "November invoice draft", "Hi Miles,\n\nThe November draft is ready for review before it goes to Xero. Let me know if anything needs changing.\n\nTom", at(now, 0, 9, 15), false, false, "conv-invoice"),
            msg("m-linear", "inbox", &linear, vec![me(&coda)], "3 issues assigned to you", "Evaluation harness, and 2 more.\n\nYou have 3 new issues assigned to you this morning.", at(now, 0, 8, 2), true, false, "conv-linear"),
            msg("m-intro", "inbox", &elena, vec![me(&coda)], "Intro: Elena / Miles", "Great to be connected. Would a call next week work?\n\nElena", at(now, 7, 11, 30), true, false, "conv-intro"),
            msg("m-sent1", "sent", &me(&coda), vec![elena.clone()], "Re: Intro: Elena / Miles", "Hi Elena, Tuesday at 3pm works. I’ll send an invite.\n\nMiles", at(now, 6, 9, 10), true, false, "conv-intro"),
        ],
    )?;
    svc.store_messages(
        &fenwick.id,
        &[msg(
            "m-access",
            "inbox",
            &priya,
            vec![me(&fenwick)],
            "Data warehouse access request",
            "Hi Miles,\n\nIT have approved read access for your account from Monday. You’ll get a separate email with the connection details.\n\nPriya",
            at(now, 0, 8, 50),
            false,
            false,
            "conv-access",
        )],
    )?;

    // Events for this work week (Monday-based), as in the calendar mockup.
    let today = now.date_naive();
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let ev = |id: &str, subject: &str, day: i64, sh: u32, sm: u32, eh: u32, em: u32, location: &str, organizer: &Address, attendees: Vec<&Address>, mine: ResponseStatus| EventRecord {
        id: id.into(),
        calendar_id: "cal".into(),
        subject: subject.into(),
        start: ev_at(monday, day, sh, sm),
        end: ev_at(monday, day, eh, em),
        location: location.into(),
        organizer: organizer.clone(),
        attendees: attendees.into_iter().map(|a| Attendee { address: a.clone(), kind: AttendeeType::Required, response: ResponseStatus::Accepted }).collect(),
        my_response: mine,
        is_online_meeting: location == "Teams",
        reminder_minutes: Some(15),
        ..Default::default()
    };
    let me_c = me(&coda);
    let me_h = me(&harbour);
    let me_f = me(&fenwick);
    svc.with_account(&coda.id, |db| {
        db.upsert_event(&ev("e-weekly", "Weekly delivery", 0, 9, 0, 9, 30, "Teams", &me_c, vec![&tom], ResponseStatus::Organizer))?;
        db.upsert_event(&ev("e-prep", "Client workshop prep", 0, 11, 0, 12, 30, "Teams", &me_c, vec![&tom], ResponseStatus::Organizer))?;
        db.upsert_event(&ev("e-intro", "Intro call: Elena Marsh", 1, 15, 0, 15, 30, "Teams", &me_c, vec![&elena], ResponseStatus::Organizer))?;
        db.upsert_event(&ev("e-focus", "Focus time", 2, 13, 0, 16, 0, "Blocked", &me_c, vec![], ResponseStatus::Organizer))?;
        db.upsert_event(&ev("e-invoicing", "Invoicing", 4, 9, 0, 10, 0, "Blocked", &me_c, vec![], ResponseStatus::Organizer))?;
        db.upsert_event(&ev("e-mentor", "Mentor chat", 4, 16, 0, 17, 0, "Teams", &me_c, vec![], ResponseStatus::Accepted))
    })?;
    svc.with_account(&harbour.id, |db| {
        db.upsert_event(&ev("e-portfolio", "Portfolio scan check-in", 2, 9, 30, 10, 30, "Teams", &james, vec![&me_h, &sarah], ResponseStatus::Accepted))?;
        db.upsert_event(&ev("e-steering", "Steering committee", 3, 10, 0, 12, 0, "Large meeting room, 3rd floor", &sarah, vec![&james, &me_h], ResponseStatus::Accepted))?;
        db.upsert_event(&ev("e-debrief", "Debrief", 3, 12, 30, 13, 0, "Teams", &sarah, vec![&me_h], ResponseStatus::None))
    })?;
    svc.with_account(&fenwick.id, |db| {
        db.upsert_event(&ev("e-data", "Data review", 0, 14, 0, 15, 0, "Teams", &priya, vec![&me_f], ResponseStatus::Accepted))?;
        db.upsert_event(&ev("e-warehouse", "Warehouse design session", 1, 10, 0, 12, 0, "Teams", &priya, vec![&me_f], ResponseStatus::Accepted))
    })?;

    for (a, html) in [
        (&coda, "<div><b>Miles Rowland</b></div><div>Coda &amp; Co</div><div><a href=\"https://coda.example\">coda.example</a></div>"),
        (&harbour, "<div><b>Miles Rowland</b></div><div>Advisor, Harbour Partners</div>"),
        (&fenwick, "<div><b>Miles Rowland</b></div><div>Fenwick Group</div>"),
    ] {
        svc.save_signature(&Signature { id: String::new(), account_id: a.id.clone(), name: "Standard".into(), html: html.into(), default_new: true, default_reply: false })?;
        svc.save_signature(&Signature { id: String::new(), account_id: a.id.clone(), name: "Short".into(), html: "<div>Miles</div>".into(), default_new: false, default_reply: true })?;
    }
    // The demo has no server: clear the queue the seed created.
    for a in [&coda, &harbour, &fenwick] {
        svc.with_account(&a.id, |db| db.all_ops()?.iter().try_for_each(|o| db.op_done(o.id)))?;
    }
    Ok(DemoIds { coda: coda.id, harbour: harbour.id, fenwick: fenwick.id, aldgate: aldgate.id })
}
