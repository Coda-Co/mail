//! People built from mail headers across Graph accounts: de-duplicated by address,
//! ranked by how recently and how often I correspond with them.

use crate::model::{Address, Person};
use chrono::{DateTime, Utc};
use std::collections::HashMap;

/// Half-life-ish decay: a message 60 days ago counts about a third of one today.
const DECAY_DAYS: f64 = 60.0;
/// Writing to someone says more than being written to.
const OUTGOING_WEIGHT: f64 = 2.0;

pub fn is_automated(email: &str) -> bool {
    let e = email.to_lowercase();
    ["noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "postmaster@"].iter().any(|p| e.contains(p))
}

/// rows: (address, received_at, outgoing, account_id)
pub fn build(rows: impl IntoIterator<Item = (Address, String, bool, String)>, me: &[String], now: DateTime<Utc>) -> Vec<Person> {
    struct Acc {
        name: String,
        name_at: String,
        accounts: Vec<String>,
        count: i64,
        last: String,
        score: f64,
    }
    let me: Vec<String> = me.iter().map(|e| e.to_lowercase()).collect();
    let mut map: HashMap<String, Acc> = HashMap::new();
    for (addr, at, outgoing, account) in rows {
        let email = addr.email.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') || me.contains(&email) || is_automated(&email) {
            continue;
        }
        let age_days = DateTime::parse_from_rfc3339(&at).map(|t| (now - t.with_timezone(&Utc)).num_seconds().max(0) as f64 / 86400.0).unwrap_or(365.0);
        let w = (-age_days / DECAY_DAYS).exp() * if outgoing { OUTGOING_WEIGHT } else { 1.0 };
        let e = map.entry(email.clone()).or_insert(Acc { name: String::new(), name_at: String::new(), accounts: vec![], count: 0, last: String::new(), score: 0.0 });
        e.count += 1;
        e.score += w;
        if at > e.last {
            e.last = at.clone();
        }
        let name = addr.name.trim();
        if !name.is_empty() && !name.eq_ignore_ascii_case(&email) && at >= e.name_at {
            e.name = name.to_string();
            e.name_at = at.clone();
        }
        if !e.accounts.contains(&account) {
            e.accounts.push(account);
        }
    }
    let mut people: Vec<Person> = map
        .into_iter()
        .map(|(email, a)| Person {
            name: if a.name.is_empty() { email.clone() } else { a.name },
            email,
            account_ids: a.accounts,
            message_count: a.count,
            last_contact_at: a.last,
            score: (a.score * 1000.0).round() / 1000.0,
        })
        .collect();
    people.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.email.cmp(&b.email)));
    people
}

/// Filter by name or address, keeping rank order.
pub fn filter<'a>(people: &'a [Person], query: &str) -> impl Iterator<Item = &'a Person> {
    let q = query.trim().to_lowercase();
    people.iter().filter(move |p| q.is_empty() || p.email.contains(&q) || p.name.to_lowercase().split_whitespace().any(|w| w.starts_with(&q)) || p.name.to_lowercase().starts_with(&q))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_recent_and_frequent() {
        let now: DateTime<Utc> = "2026-11-23T10:00:00Z".parse().unwrap();
        let a = |n: &str, e: &str| Address::new(n, e);
        let rows = vec![
            (a("Sarah Okafor", "Sarah@harbour.example"), "2026-11-23T09:42:00Z".to_string(), false, "h".to_string()),
            (a("", "sarah@harbour.example"), "2026-11-12T09:00:00Z".to_string(), true, "c".to_string()),
            (a("Old Contact", "old@x.example"), "2025-01-01T09:00:00Z".to_string(), false, "c".to_string()),
            (a("Old Contact", "old@x.example"), "2025-01-02T09:00:00Z".to_string(), false, "c".to_string()),
            (a("Me", "me@coda.example"), "2026-11-23T09:00:00Z".to_string(), false, "c".to_string()),
            (a("Robot", "no-reply@x.example"), "2026-11-23T09:00:00Z".to_string(), false, "c".to_string()),
        ];
        let people = build(rows, &["ME@coda.example".to_string()], now);
        assert_eq!(people.len(), 2);
        assert_eq!(people[0].email, "sarah@harbour.example");
        assert_eq!(people[0].name, "Sarah Okafor");
        assert_eq!(people[0].message_count, 2);
        assert_eq!(people[0].account_ids, vec!["h", "c"]);
        assert_eq!(filter(&people, "oka").count(), 1);
        assert_eq!(filter(&people, "x.example").count(), 1);
    }
}
