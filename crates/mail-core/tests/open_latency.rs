//! Timing harness for opening a message (run with --ignored --nocapture).
use mail_core::db::account::MessageRecord;
use mail_core::model::*;
use mail_core::MailService;
use std::time::Instant;

fn newsletter(seed: usize, kb: usize) -> String {
    let mut s = String::from("<html><head><style>");
    for i in 0..120 {
        s.push_str(&format!(".c{i}{{font-family:Arial,sans-serif;font-size:14px;color:#333;padding:{i}px}} @media (max-width:600px){{.c{i}{{width:100%!important}}}}\n"));
    }
    s.push_str("</style></head><body><table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#f4f4f4\">");
    let mut i = 0;
    while s.len() < kb * 1024 {
        s.push_str(&format!(
            "<tr><td class=\"c{}\" style=\"padding:12px 24px;font-family:Arial\"><table width=\"100%\"><tr><td><img src=\"https://cdn.example.com/img/{seed}/{i}.png\" width=\"600\" height=\"200\" alt=\"x\"></td></tr><tr><td><p style=\"margin:0 0 12px\">Item {i}: Lorem ipsum dolor sit amet, <a href=\"https://track.example.com/c/{seed}/{i}?utm_source=x\">consectetur</a> adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></td></tr></table></td></tr>",
            i % 120
        ));
        i += 1;
    }
    s.push_str("</table></body></html>");
    s
}

fn reply(i: usize, quoted: &str) -> String {
    format!("<div><p>Reply number {i}. Thanks, sounds good — let's discuss on Thursday.</p></div><hr><blockquote>{quoted}</blockquote>")
}

fn time<T>(label: &str, n: usize, mut f: impl FnMut() -> T) {
    f();
    let t = Instant::now();
    for _ in 0..n {
        f();
    }
    println!("{label:<55} {:>8.2} ms", t.elapsed().as_secs_f64() * 1000.0 / n as f64);
}

#[test]
#[ignore]
fn open_latency() {
    let dir = tempfile::tempdir().unwrap();
    let svc = MailService::open(dir.path()).unwrap();
    let acc = svc.add_graph_account("me@example.com", "Bench", Some("t".into()), None).unwrap();
    svc.with_account(&acc.id, |db| {
        db.upsert_folder("inbox", "Inbox", Some(FolderRole::Inbox), None, 0)?;
        db.upsert_folder("junk", "Junk", Some(FolderRole::Junk), None, 0)
    })
    .unwrap();
    let from = Address::new("Sender", "sender@example.com");
    let rec = |id: String, conv: String, body: String, day: usize| MessageRecord {
        id,
        folder_id: "inbox".into(),
        conversation_id: conv,
        from: from.clone(),
        to: vec![Address::new("Me", "me@example.com")],
        subject: "Subject".into(),
        snippet: "snippet".into(),
        body_html: Some(body),
        received_at: format!("2026-{:02}-{:02}T10:00:00Z", 1 + (day / 28) % 11, 1 + day % 28),
        ..Default::default()
    };

    // A mailbox: 4000 messages of mixed size.
    let t = Instant::now();
    let mut batch = vec![];
    for i in 0..4000 {
        let body = if i % 4 == 0 { newsletter(i, 60) } else { reply(i, "<p>short quoted text</p>") };
        batch.push(rec(format!("bg{i}"), format!("bgc{i}"), body, i));
        if batch.len() == 200 {
            svc.store_messages(&acc.id, &batch).unwrap();
            batch.clear();
        }
    }
    println!("seeded 4000 messages in {:.1}s", t.elapsed().as_secs_f64());

    // Targets.
    svc.store_messages(&acc.id, &[rec("plain".into(), "c-plain".into(), reply(0, "<p>hi</p>"), 1)]).unwrap();
    for kb in [30, 100, 250] {
        svc.store_messages(&acc.id, &[rec(format!("nl{kb}"), format!("c-nl{kb}"), newsletter(kb, kb), 1)]).unwrap();
    }
    // A 15-message reply chain where each message quotes the whole previous one.
    let mut quoted = String::from("<p>original</p>");
    let mut chain = vec![];
    for i in 0..15 {
        let body = reply(i, &quoted);
        quoted = body.clone();
        chain.push(rec(format!("ch{i}"), "c-chain".into(), body, i));
    }
    svc.store_messages(&acc.id, &chain).unwrap();
    println!("chain: last body {} KB", quoted.len() / 1024);

    let id = |raw: &str| format!("{}:{}", acc.id, raw);
    println!("\n{:<55} {:>11}", "operation", "avg");
    time("get_thread: plain 1-message", 50, || svc.get_thread(&id("plain")).unwrap());
    for kb in [30, 100, 250] {
        time(&format!("get_thread: newsletter {kb} KB"), 20, || svc.get_thread(&id(&format!("nl{kb}"))).unwrap());
    }
    time("get_thread: 15-message quoted reply chain", 10, || svc.get_thread(&id("ch14")).unwrap());
    time("stored_message only (SQLite read), 250 KB", 50, || svc.stored_message(&id("nl250")).unwrap());
    let body = svc.stored_message(&id("nl250")).unwrap().message.body_html;
    time("sanitize_mail_for_display only, 250 KB", 20, || mail_core::html::sanitize_mail_for_display(&body, true, &Default::default()));
    time("serde_json of rendered 15-message thread", 20, || serde_json::to_string(&svc.get_thread(&id("ch14")).unwrap()).unwrap());
    let thread = svc.get_thread(&id("ch14")).unwrap();
    println!("rendered chain thread JSON size: {} KB", serde_json::to_string(&thread).unwrap().len() / 1024);

    // prune_bodies-equivalent: a full scan that holds the account lock during a sync.
    time("prune_bodies UPDATE (scan, nothing to prune)", 5, || {
        svc.with_account(&acc.id, |db| {
            db.conn.execute("UPDATE messages SET body_html = NULL WHERE received_at < '2000-01-01' AND body_html IS NOT NULL", [])?;
            Ok(())
        })
        .unwrap()
    });
}
