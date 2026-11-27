//! Live check of "Find times" against the real model, using made-up emails written in the
//! styles seen in real scheduling mail (tests/fixtures/find_times.json).
//!
//! Needs an AI Gateway key, so it is ignored by default:
//!   MAIL_APP_AI_KEY=... cargo test -p mail-core --test find_times_live -- --ignored --nocapture
//! Optional: MAIL_APP_AI_MODEL (default the app's), FIND_TIMES_RUNS (repeat each email, default 1).

use chrono::{DateTime, Utc};
use mail_core::times::{self, EmailInput, ProposedSlot, TimeProposals};
use serde::Deserialize;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    subject: String,
    from: String,
    sent_at: DateTime<Utc>,
    body: String,
    #[serde(default)]
    expect: Vec<Expect>,
    #[serde(default)]
    forbid: Vec<String>,
    #[serde(default)]
    only_approximate: bool,
}

#[derive(Deserialize, Clone)]
struct Expect {
    /// Full UTC time, or just a date for loose wording.
    start: String,
    end: Option<String>,
    minutes: Option<i64>,
    #[serde(default)]
    approximate: bool,
}

fn matches(e: &Expect, s: &ProposedSlot) -> bool {
    if e.start.len() == 10 {
        return s.window_start.starts_with(&e.start) && (!e.approximate || s.approximate);
    }
    s.window_start == e.start && e.end.as_ref().is_none_or(|end| &s.window_end == end) && e.minutes.is_none_or(|m| s.minutes == m)
}

/// Problems with one answer; empty when it's right. Extra slots are reported but allowed.
fn grade(c: &Case, p: &TimeProposals) -> (Vec<String>, Vec<String>) {
    let mut problems = Vec::new();
    for e in &c.expect {
        if !p.slots.iter().any(|s| matches(e, s)) {
            problems.push(format!("missing {}{}", e.start, e.end.as_deref().map(|x| format!("–{x}")).unwrap_or_default()));
        }
    }
    for f in &c.forbid {
        for s in p.slots.iter().filter(|s| s.window_start.starts_with(f.as_str())) {
            problems.push(format!("should not offer {} (“{}”)", s.window_start, s.quote));
        }
    }
    if c.only_approximate {
        for s in p.slots.iter().filter(|s| !s.approximate) {
            problems.push(format!("precise slot from vague wording: {} (“{}”)", s.window_start, s.quote));
        }
    }
    let extras = p
        .slots
        .iter()
        .filter(|s| !c.expect.iter().any(|e| matches(e, s)) && !c.only_approximate)
        .map(|s| format!("{}–{} {:?} “{}”", s.window_start, s.window_end, s.kind, s.quote))
        .collect();
    (problems, extras)
}

#[tokio::test]
#[ignore]
async fn real_model_reads_scheduling_emails() {
    let key = std::env::var("MAIL_APP_AI_KEY").expect("set MAIL_APP_AI_KEY");
    let model = std::env::var("MAIL_APP_AI_MODEL").unwrap_or_else(|_| times::DEFAULT_MODEL.into());
    let url = std::env::var("MAIL_APP_AI_GATEWAY_URL").unwrap_or_else(|_| times::GATEWAY_URL.into());
    let runs: usize = std::env::var("FIND_TIMES_RUNS").ok().and_then(|r| r.parse().ok()).unwrap_or(1);
    let cases: Vec<Case> = serde_json::from_str(include_str!("fixtures/find_times.json")).unwrap();
    let tz: chrono_tz::Tz = "Europe/London".parse().unwrap();
    // Behind a TLS-intercepting proxy, trust its CA too (the app's client only knows the public roots).
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(90));
    if let Ok(path) = std::env::var("SSL_CERT_FILE") {
        for cert in reqwest::Certificate::from_pem_bundle(&std::fs::read(path).unwrap()).unwrap() {
            builder = builder.add_root_certificate(cert);
        }
    }
    let http = builder.build().unwrap();

    let mut jobs = Vec::new();
    for c in &cases {
        for run in 0..runs {
            let (c, http, key, model, url) = (c.clone(), http.clone(), key.clone(), model.clone(), url.clone());
            jobs.push(tokio::spawn(async move {
                let email = EmailInput { subject: c.subject.clone(), from_name: c.from.clone(), me_name: "Miles Rowland".into(), sent_at: c.sent_at, body_text: c.body.clone() };
                let started = std::time::Instant::now();
                let answer = times::find(&http, &url, &key, &model, &email, tz).await;
                (c, run, answer, started.elapsed())
            }));
        }
    }

    let (mut passed, mut total) = (0, 0);
    for job in jobs {
        let (c, run, answer, took) = job.await.unwrap();
        total += 1;
        match answer {
            Ok(p) => {
                let (problems, extras) = grade(&c, &p);
                let ok = problems.is_empty();
                passed += ok as usize;
                println!("{} [{run}] {} ({:.1}s) — {}", if ok { "PASS" } else { "FAIL" }, c.name, took.as_secs_f32(), p.summary);
                for x in &problems {
                    println!("      ✗ {x}");
                }
                for x in &extras {
                    println!("      + extra {x}");
                }
                for s in &p.slots {
                    for w in &s.warnings {
                        println!("      ! {} {w}", s.window_start);
                    }
                }
            }
            Err(e) => println!("ERROR [{run}] {}: {e}", c.name),
        }
    }
    println!("\n{passed}/{total} passed with {model}");
    assert_eq!(passed, total);
}
