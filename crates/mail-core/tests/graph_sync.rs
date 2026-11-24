//! Sync against a mock Microsoft Graph.

use mail_core::auth::Tokens;
use mail_core::graph::GraphClient;
use mail_core::model::*;
use mail_core::sync::Syncer;
use mail_core::{EventSink, MailService};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wiremock::matchers::{body_partial_json, method, path, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Default)]
struct Captured {
    new_mail: Mutex<Vec<String>>,
}
impl EventSink for Captured {
    fn new_mail(&self, _a: &Account, m: &[MessageSummary]) {
        self.new_mail.lock().unwrap().extend(m.iter().map(|x| x.subject.clone()));
    }
}

fn msg(id: &str, folder: &str, subject: &str, read: bool) -> serde_json::Value {
    json!({
        "id": id, "conversationId": format!("conv-{id}"), "subject": subject, "bodyPreview": "preview",
        "body": {"contentType": "html", "content": format!("<p>{subject}</p>")},
        "from": {"emailAddress": {"name": "Sarah Okafor", "address": "sarah@harbour.example"}},
        "toRecipients": [{"emailAddress": {"name": "Miles", "address": "miles@coda.example"}}],
        "receivedDateTime": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "isRead": read, "flag": {"flagStatus": "notFlagged"}, "hasAttachments": false, "isDraft": false, "parentFolderId": folder
    })
}

async fn world(server: &MockServer) {
    let uri = server.uri();
    Mock::given(method("GET")).and(path("/me")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"displayName": "Miles Rowland", "mail": "miles@coda.example"}))).mount(server).await;
    for (name, id) in [("inbox", "F-INBOX"), ("drafts", "F-DRAFTS"), ("sentitems", "F-SENT"), ("archive", "F-ARCH"), ("deleteditems", "F-DEL")] {
        Mock::given(method("GET")).and(path(format!("/me/mailFolders/{name}"))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": id}))).mount(server).await;
    }
    Mock::given(method("GET")).and(path("/me/mailFolders/junkemail")).respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": {"code": "ErrorItemNotFound", "message": "nope"}}))).mount(server).await;
    let folders: Vec<_> = [("F-INBOX", "Inbox"), ("F-DRAFTS", "Drafts"), ("F-SENT", "Sent Items"), ("F-ARCH", "Archive"), ("F-DEL", "Deleted Items"), ("F-PROJ", "Projects"), ("F-RSS", "RSS Feeds")]
        .iter()
        .map(|(id, n)| json!({"id": id, "displayName": n, "totalItemCount": 3, "childFolderCount": 0}))
        .collect();
    Mock::given(method("GET")).and(path("/me/mailFolders")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": folders}))).mount(server).await;
    // Inbox: two pages, then a delta link.
    Mock::given(method("GET"))
        .and(path("/me/mailFolders/F-INBOX/messages/delta"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": [msg("M2", "F-INBOX", "Invoice", true)], "@odata.deltaLink": format!("{uri}/me/mailFolders/F-INBOX/messages/delta?$deltatoken=t1")})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/me/mailFolders/F-INBOX/messages/delta"))
        .and(query_param("$deltatoken", "t1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "value": [{"id": "M2", "@removed": {"reason": "deleted"}}, msg("M3", "F-INBOX", "Brand new", false)],
            "@odata.deltaLink": format!("{uri}/me/mailFolders/F-INBOX/messages/delta?$deltatoken=t2")
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/me/mailFolders/F-INBOX/messages/delta"))
        .and(query_param("$deltatoken", "t2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": [], "@odata.deltaLink": format!("{uri}/me/mailFolders/F-INBOX/messages/delta?$deltatoken=t2")})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/me/mailFolders/F-INBOX/messages/delta"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": [msg("M1", "F-INBOX", "Steering agenda", false)], "@odata.nextLink": format!("{uri}/me/mailFolders/F-INBOX/messages/delta?page=2")})))
        .with_priority(10)
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/me/mailFolders/F-(DRAFTS|SENT|ARCH|DEL|PROJ)/messages/delta$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": [], "@odata.deltaLink": format!("{uri}/empty-delta")})))
        .mount(server)
        .await;
    Mock::given(method("GET")).and(path("/empty-delta")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": [], "@odata.deltaLink": format!("{uri}/empty-delta")}))).mount(server).await;
    Mock::given(method("GET"))
        .and(path("/me/calendars"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": [{"id": "CAL1", "name": "Calendar", "isDefaultCalendar": true, "canEdit": true}]})))
        .mount(server)
        .await;
    let start = (chrono::Utc::now() + chrono::Duration::days(1)).format("%Y-%m-%dT10:00:00.0000000").to_string();
    let end = (chrono::Utc::now() + chrono::Duration::days(1)).format("%Y-%m-%dT11:00:00.0000000").to_string();
    Mock::given(method("GET"))
        .and(path("/me/calendarView/delta"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "value": [{"id": "EV1", "subject": "Steering committee", "start": {"dateTime": start, "timeZone": "UTC"}, "end": {"dateTime": end, "timeZone": "UTC"},
                       "organizer": {"emailAddress": {"name": "Sarah", "address": "sarah@harbour.example"}}, "responseStatus": {"response": "notResponded"}, "attendees": []}],
            "@odata.deltaLink": format!("{uri}/me/calendarView/delta?$deltatoken=c1")
        })))
        .mount(server)
        .await;
}

fn client(server: &MockServer, timeout: Duration) -> GraphClient {
    let http = reqwest::Client::builder().timeout(timeout).build().unwrap();
    GraphClient::new(http, server.uri(), Arc::new(Tokens::fixed("test-token"))).with_max_wait(Duration::from_millis(50))
}

async fn setup() -> (MockServer, Arc<MailService>, Account, Arc<Captured>) {
    let server = MockServer::start().await;
    world(&server).await;
    let svc = Arc::new(MailService::in_memory().unwrap());
    let events = Arc::new(Captured::default());
    svc.set_events(events.clone());
    let acc = svc.add_graph_account("miles@coda.example", "Coda & Co", Some("tid".into()), None).unwrap();
    (server, svc, acc, events)
}

#[tokio::test]
async fn first_and_incremental_sync() {
    let (server, svc, acc, events) = setup().await;
    let g = client(&server, Duration::from_secs(10));
    let r = Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    assert!(!r.offline);
    let folders = svc.list_folders(Some(&acc.id)).unwrap();
    let names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, vec!["Inbox", "Drafts", "Sent Items", "Archive", "Deleted Items", "Projects"], "system folders hidden, roles first");
    let inbox = svc.list_messages(&ViewScope::unified_inbox(), 50, 0).unwrap();
    assert_eq!(inbox.len(), 2, "both delta pages stored");
    assert!(events.new_mail.lock().unwrap().is_empty(), "no notifications for the first sync");
    assert_eq!(svc.me().unwrap().name, "Miles Rowland");
    assert_eq!(svc.list_events("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z").unwrap()[0].subject, "Steering committee");
    assert_eq!(svc.get_account(&acc.id).unwrap().sync_state, SyncState::Idle);

    // Incremental: M2 removed, M3 new and unread.
    let acc = svc.get_account(&acc.id).unwrap();
    Syncer::new(&svc, &g, acc).run().await.unwrap();
    let subjects: Vec<String> = svc.list_messages(&ViewScope::unified_inbox(), 50, 0).unwrap().into_iter().map(|m| m.subject).collect();
    assert!(subjects.contains(&"Brand new".to_string()));
    assert!(!subjects.contains(&"Invoice".to_string()));
    assert_eq!(*events.new_mail.lock().unwrap(), vec!["Brand new".to_string()]);
    // Search sees synced mail.
    let q = SearchQuery { text: "brand".into(), scope: ViewScope::unified_inbox(), all_folders: false, from: None, to: None, has_attachment: None, unread: None, date: None, account_id: None, field: SearchField::All };
    assert_eq!(svc.search(&q).unwrap().total, 1);
}

#[tokio::test]
async fn local_changes_replay() {
    let (server, svc, acc, _) = setup().await;
    let g = client(&server, Duration::from_secs(10));
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    Mock::given(method("PATCH")).and(path("/me/messages/M1")).and(body_partial_json(json!({"isRead": true}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({}))).expect(1).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/me/messages/M2/move"))
        .and(body_partial_json(json!({"destinationId": "archive"})))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({"id": "M2", "parentFolderId": "F-ARCH"})))
        .expect(1)
        .mount(&server)
        .await;
    let id1 = format!("{}:M1", acc.id);
    let id2 = format!("{}:M2", acc.id);
    svc.mark_read(std::slice::from_ref(&id1), true).unwrap();
    svc.archive(std::slice::from_ref(&id2)).unwrap();
    let r = Syncer::new(&svc, &g, svc.get_account(&acc.id).unwrap()).run().await.unwrap();
    assert_eq!(r.ops_done, 2);
    assert!(svc.with_account(&acc.id, |db| db.all_ops()).unwrap().is_empty());
    assert_eq!(svc.get_message(&id2).unwrap().summary.folder_id, format!("{}:F-ARCH", acc.id));
}

#[tokio::test]
async fn reply_is_created_saved_and_sent() {
    let (server, svc, acc, _) = setup().await;
    let g = client(&server, Duration::from_secs(10));
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    Mock::given(method("POST")).and(path("/me/messages/M1/createReply")).respond_with(ResponseTemplate::new(201).set_body_json(json!({"id": "D1"}))).expect(1).mount(&server).await;
    Mock::given(method("PATCH"))
        .and(path("/me/messages/D1"))
        .and(body_partial_json(json!({"toRecipients": [{"emailAddress": {"address": "sarah@harbour.example"}}]})))
        .and(wiremock::matchers::body_string_contains("<blockquote>"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/me/messages/D1/attachments")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": []}))).mount(&server).await;
    Mock::given(method("POST")).and(path("/me/messages/D1/send")).respond_with(ResponseTemplate::new(202)).expect(1).mount(&server).await;

    let d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::Reply, source_message_id: Some(format!("{}:M1", acc.id)), account_id: None }).unwrap();
    svc.send_draft(&d.id).unwrap();
    let r = Syncer::new(&svc, &g, svc.get_account(&acc.id).unwrap()).run().await.unwrap();
    assert_eq!(r.ops_done, 2, "save then send");
    assert!(svc.get_draft(&d.id).is_err(), "sent drafts are removed");
    assert_eq!(svc.sync_status().unwrap().outbox_held, 0);
}

#[tokio::test]
async fn unknown_send_is_held_never_repeated() {
    let (server, svc, acc, _) = setup().await;
    // Short client timeout so the slow send below has no answer.
    let g = client(&server, Duration::from_millis(800));
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    Mock::given(method("POST")).and(path("/me/messages")).respond_with(ResponseTemplate::new(201).set_body_json(json!({"id": "D2"}))).mount(&server).await;
    Mock::given(method("PATCH")).and(path("/me/messages/D2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({}))).mount(&server).await;
    Mock::given(method("GET")).and(path("/me/messages/D2/attachments")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": []}))).mount(&server).await;
    // The send is processed but the answer never arrives in time. Exactly one send ever reaches the server.
    Mock::given(method("POST")).and(path("/me/messages/D2/send")).respond_with(ResponseTemplate::new(202).set_delay(Duration::from_secs(3))).expect(1).mount(&server).await;

    // While held, the server draft is still in Drafts (checked once per cycle, twice here).
    Mock::given(method("GET"))
        .and(path("/me/messages/D2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "D2", "isDraft": true})))
        .up_to_n_times(2)
        .with_priority(1)
        .mount(&server)
        .await;
    let mut d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(acc.id.clone()) }).unwrap();
    d.to = vec![Address::new("Tom", "tom@coda.example")];
    d.subject = "Hello".into();
    let d = svc.update_draft(&d).unwrap();
    svc.send_draft(&d.id).unwrap();
    Syncer::new(&svc, &g, svc.get_account(&acc.id).unwrap()).run().await.unwrap();
    let held = svc.get_draft(&d.id).unwrap();
    assert_eq!(held.status, DraftStatus::Unknown);
    assert!(held.error.clone().unwrap().contains("Check Sent"));
    assert_eq!(svc.sync_status().unwrap().outbox_held, 1);
    assert!(svc.update_draft(&held).is_err(), "held drafts can't be edited");

    // Next cycle: the server draft still exists, so it stays held; nothing is re-sent.
    Syncer::new(&svc, &g, svc.get_account(&acc.id).unwrap()).run().await.unwrap();
    assert_eq!(svc.get_draft(&d.id).unwrap().status, DraftStatus::Unknown);

    // Then the server draft is gone (it was sent): resolved without sending again.
    Mock::given(method("GET")).and(path("/me/messages/D2")).respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": {"code": "ErrorItemNotFound", "message": ""}}))).mount(&server).await;
    Syncer::new(&svc, &g, svc.get_account(&acc.id).unwrap()).run().await.unwrap();
    assert!(svc.get_draft(&d.id).is_err());
    assert_eq!(svc.sync_status().unwrap().outbox_held, 0);
}

#[tokio::test]
async fn offline_send_waits_for_reconnect() {
    let svc = Arc::new(MailService::in_memory().unwrap());
    let acc = svc.add_graph_account("miles@coda.example", "Coda", None, None).unwrap();
    svc.with_account(&acc.id, |db| db.upsert_folder("F-INBOX", "Inbox", Some(FolderRole::Inbox), None, 0)).unwrap();
    let mut d = svc.create_draft(&CreateDraftRequest { mode: DraftMode::New, source_message_id: None, account_id: Some(acc.id.clone()) }).unwrap();
    d.to = vec![Address::new("Tom", "tom@coda.example")];
    let d = svc.update_draft(&d).unwrap();
    svc.send_draft(&d.id).unwrap();
    // Nothing listens on this port: connection refused = certainly not sent.
    let g = GraphClient::new(reqwest::Client::new(), "http://127.0.0.1:9", Arc::new(Tokens::fixed("t")));
    let r = Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    assert!(r.offline);
    assert!(!svc.is_online());
    assert_eq!(svc.get_account(&acc.id).unwrap().sync_state, SyncState::Offline);
    assert_eq!(svc.get_draft(&d.id).unwrap().status, DraftStatus::Queued, "still queued, not held");
    let ops = svc.with_account(&acc.id, |db| db.all_ops()).unwrap();
    assert!(ops.iter().all(|o| o.state == "pending"));
    assert!(ops[0].attempts >= 1);
}

#[tokio::test]
async fn throttling_respects_retry_after() {
    let (server, svc, acc, _) = setup().await;
    Mock::given(method("GET"))
        .and(path("/me/calendars"))
        .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "1").set_body_json(json!({"error": {"code": "TooManyRequests", "message": "slow down"}})))
        .up_to_n_times(1)
        .with_priority(1)
        .expect(1)
        .mount(&server)
        .await;
    let g = client(&server, Duration::from_secs(10));
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    assert_eq!(svc.list_calendars().unwrap().len(), 1, "retried after throttling");
}

#[tokio::test]
async fn expired_sign_in_marks_account() {
    let server = MockServer::start().await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": {"code": "InvalidAuthenticationToken", "message": "expired"}}))).mount(&server).await;
    let svc = Arc::new(MailService::in_memory().unwrap());
    let acc = svc.add_graph_account("miles@coda.example", "Coda", None, None).unwrap();
    let g = client(&server, Duration::from_secs(5));
    assert!(Syncer::new(&svc, &g, acc.clone()).run().await.is_err());
    assert_eq!(svc.get_account(&acc.id).unwrap().sync_state, SyncState::NeedsAuth);
    assert_eq!(svc.sync_status().unwrap().label, "Sign in needed");
    // Signing in again clears it.
    let again = svc.add_graph_account("miles@coda.example", "Coda", None, None).unwrap();
    assert_eq!(again.id, acc.id);
    assert_eq!(svc.get_account(&acc.id).unwrap().sync_state, SyncState::Idle);
}

#[tokio::test]
async fn bare_calendar_occurrences_keep_their_titles() {
    let (server, svc, acc, _events) = setup().await;
    let g = client(&server, Duration::from_secs(10));
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();

    // The next delta round sends occurrences with only id, type, times and seriesMasterId:
    // EV1 (already stored) moved by an hour, OCC1 is new and only its series master has a title.
    let day = chrono::Utc::now() + chrono::Duration::days(1);
    let t = |h: u32| json!({"dateTime": day.format(&format!("%Y-%m-%dT{h:02}:00:00.0000000")).to_string(), "timeZone": "UTC"});
    Mock::given(method("GET"))
        .and(path("/me/calendarView/delta"))
        .and(query_param("$deltatoken", "c1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "value": [
                {"id": "EV1", "type": "occurrence", "seriesMasterId": "MASTER0", "start": t(11), "end": t(12)},
                {"id": "OCC1", "type": "occurrence", "seriesMasterId": "MASTER1", "start": t(16), "end": t(17)}
            ],
            "@odata.deltaLink": format!("{}/me/calendarView/delta?$deltatoken=c2", server.uri())
        })))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/me/events/MASTER1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "MASTER1", "subject": "Pacifica daily sync", "location": {"displayName": "Teams"}})))
        .expect(1)
        .mount(&server)
        .await;
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();

    let events = svc.list_events("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z").unwrap();
    let ev1 = events.iter().find(|e| e.id.ends_with("EV1")).unwrap();
    assert_eq!(ev1.subject, "Steering committee", "stored title kept");
    assert!(ev1.start.contains("T11:00:00"), "new time applied");
    let occ = events.iter().find(|e| e.id.ends_with("OCC1")).unwrap();
    assert_eq!(occ.subject, "Pacifica daily sync", "title from the series master");
    assert_eq!(occ.location, "Teams");
}

#[tokio::test]
async fn partial_message_delta_items_keep_details() {
    let (server, svc, acc, events) = setup().await;
    let g = client(&server, Duration::from_secs(10));
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();

    // The next round sends M1 (stored) with only its new read state, and M4 (new mail)
    // with nothing but its id: the details have to be fetched.
    Mock::given(method("GET"))
        .and(path("/me/mailFolders/F-INBOX/messages/delta"))
        .and(query_param("$deltatoken", "t1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "value": [{"id": "M1", "isRead": true}, {"id": "M4"}],
            "@odata.deltaLink": format!("{}/me/mailFolders/F-INBOX/messages/delta?$deltatoken=t2", server.uri())
        })))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/me/messages/M4")).respond_with(ResponseTemplate::new(200).set_body_json(msg("M4", "F-INBOX", "DocuSign completed", false))).expect(1).mount(&server).await;
    Mock::given(method("GET")).and(path("/me/messages/M1")).respond_with(ResponseTemplate::new(500)).expect(0).mount(&server).await;
    let acc = svc.get_account(&acc.id).unwrap();
    Syncer::new(&svc, &g, acc).run().await.unwrap();

    let inbox = svc.list_messages(&ViewScope::unified_inbox(), 50, 0).unwrap();
    let m1 = inbox.iter().find(|m| m.id.ends_with("M1")).unwrap();
    assert_eq!(m1.subject, "Steering agenda", "stored subject kept");
    assert_eq!(m1.from.email, "sarah@harbour.example", "stored sender kept");
    assert!(!m1.received_at.is_empty(), "stored date kept");
    assert!(m1.is_read, "new read state applied");
    let m4 = inbox.iter().find(|m| m.id.ends_with("M4")).expect("new mail stored");
    assert_eq!(m4.subject, "DocuSign completed");
    assert!(!m4.received_at.is_empty());
    assert_eq!(*events.new_mail.lock().unwrap(), vec!["DocuSign completed".to_string()]);
}

#[tokio::test]
async fn inbox_pass_fetches_new_mail_with_one_request() {
    let (server, svc, acc, events) = setup().await;
    let g = client(&server, Duration::from_secs(10));
    // Before the first full sync there is nothing to build on: no requests at all.
    Syncer::new(&svc, &g, acc.clone()).run_inbox().await.unwrap();
    assert!(server.received_requests().await.unwrap().is_empty());

    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    let before = server.received_requests().await.unwrap().len();
    let acc = svc.get_account(&acc.id).unwrap();
    let r = Syncer::new(&svc, &g, acc.clone()).run_inbox().await.unwrap();
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len() - before, 1, "only the inbox delta link");
    assert!(requests.last().unwrap().url.query().unwrap_or("").contains("deltatoken=t1"));

    assert_eq!(r.messages_changed, 2);
    let subjects: Vec<String> = svc.list_messages(&ViewScope::unified_inbox(), 50, 0).unwrap().into_iter().map(|m| m.subject).collect();
    assert!(subjects.contains(&"Brand new".to_string()));
    assert!(!subjects.contains(&"Invoice".to_string()));
    assert_eq!(*events.new_mail.lock().unwrap(), vec!["Brand new".to_string()]);
    assert_eq!(svc.get_account(&acc.id).unwrap().sync_state, SyncState::Idle);
}

#[tokio::test]
async fn attachments_are_cached_during_sync() {
    let (server, svc, acc, _) = setup().await;
    let g = client(&server, Duration::from_secs(10));
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let rec = |id: &str, received_at: &str| mail_core::db::account::MessageRecord {
        id: id.into(),
        folder_id: "F-INBOX".into(),
        conversation_id: format!("conv-{id}"),
        subject: id.into(),
        body_html: Some("<p>hi</p>".into()),
        received_at: received_at.into(),
        has_attachments: true,
        ..Default::default()
    };
    // A1: deck + a cloud link (no content); A2: flagged but the server lists nothing;
    // OLD: outside the offline window, left for on-demand download.
    svc.store_messages(&acc.id, &[rec("A1", &now), rec("A2", &now), rec("OLD", "2001-01-01T00:00:00Z")]).unwrap();
    Mock::given(method("GET"))
        .and(path("/me/messages/A1/attachments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": [
            {"id": "deck", "name": "Steerco.pptx", "contentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "size": 4, "isInline": false},
            {"id": "link", "name": "Shared folder", "contentType": "", "size": 0, "isInline": false}
        ]})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/me/messages/A1/attachments/deck/$value")).respond_with(ResponseTemplate::new(200).set_body_bytes(b"PPTX".to_vec())).expect(1).mount(&server).await;
    Mock::given(method("GET"))
        .and(path("/me/messages/A1/attachments/link/$value"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"error": {"code": "ErrorInvalidRequest", "message": "reference attachment"}})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/me/messages/A2/attachments")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": []}))).expect(1).mount(&server).await;
    Mock::given(method("GET")).and(path("/me/messages/OLD/attachments")).respond_with(ResponseTemplate::new(500)).expect(0).mount(&server).await;

    let acc = svc.get_account(&acc.id).unwrap();
    let r = Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    assert!(r.messages_changed >= 1, "new attachment chips are announced");

    let m = svc.get_message(&format!("{}:A1", acc.id)).unwrap();
    let deck = m.attachments.iter().find(|a| a.id == "deck").unwrap();
    let local = deck.local_path.as_deref().expect("deck cached during sync");
    assert_eq!(std::fs::read(local).unwrap(), b"PPTX");

    // The next cycles don't ask again: not for the empty list, nor the refused link.
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();
    Syncer::new(&svc, &g, acc).run_inbox().await.unwrap();
}

#[tokio::test]
async fn cached_attachments_are_pruned_outside_the_window() {
    let (server, svc, acc, _) = setup().await;
    let g = client(&server, Duration::from_secs(10));
    Syncer::new(&svc, &g, acc.clone()).run().await.unwrap();

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let rec = |received_at: &str| mail_core::db::account::MessageRecord {
        id: "P1".into(),
        folder_id: "F-INBOX".into(),
        conversation_id: "conv-P1".into(),
        subject: "Deck".into(),
        body_html: Some("<p>hi</p>".into()),
        received_at: received_at.into(),
        has_attachments: true,
        ..Default::default()
    };
    svc.store_messages(&acc.id, &[rec(&now)]).unwrap();
    Mock::given(method("GET"))
        .and(path("/me/messages/P1/attachments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": [{"id": "deck", "name": "Deck.pptx", "contentType": "", "size": 4, "isInline": false}]})))
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/me/messages/P1/attachments/deck/$value")).respond_with(ResponseTemplate::new(200).set_body_bytes(b"PPTX".to_vec())).mount(&server).await;
    Syncer::new(&svc, &g, svc.get_account(&acc.id).unwrap()).run().await.unwrap();
    let id = format!("{}:P1", acc.id);
    let cached = svc.get_message(&id).unwrap().attachments[0].local_path.clone().expect("cached");

    // Leftovers: a file from a message that was since deleted, and one opened a moment ago.
    let root = svc.paths.attachments_dir(&acc.id);
    std::fs::create_dir_all(root.join("gone")).unwrap();
    let orphan = root.join("gone").join("old.pdf");
    let fresh = root.join("gone").join("just-opened.pdf");
    std::fs::write(&orphan, b"x").unwrap();
    std::fs::write(&fresh, b"x").unwrap();
    let two_hours_ago = std::time::SystemTime::now() - Duration::from_secs(7200);
    for p in [std::path::PathBuf::from(&cached), orphan.clone()] {
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(two_hours_ago).unwrap();
    }

    // Still inside the window: nothing of P1's is touched, only the orphan goes.
    Syncer::new(&svc, &g, svc.get_account(&acc.id).unwrap()).run().await.unwrap();
    assert!(std::path::Path::new(&cached).exists());
    assert!(!orphan.exists(), "deleted message's file removed");
    assert!(fresh.exists(), "recently opened file kept for now");

    // P1 slides out of the window: its file is removed and forgotten, the chip stays.
    svc.store_messages(&acc.id, &[rec("2001-01-01T00:00:00Z")]).unwrap();
    Syncer::new(&svc, &g, svc.get_account(&acc.id).unwrap()).run().await.unwrap();
    assert!(!std::path::Path::new(&cached).exists());
    let m = svc.get_message(&id).unwrap();
    assert_eq!(m.attachments.len(), 1, "still listed, downloads on demand");
    assert!(m.attachments[0].local_path.is_none());
}
