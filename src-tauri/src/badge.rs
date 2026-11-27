//! "New mail" badge, as classic Outlook's taskbar envelope works: it comes on when new unread
//! mail reaches an Inbox and goes off when you read an unread message. It is not the unread
//! count. Mail you leave unread on purpose doesn't keep it on, and it doesn't go off on its
//! own while the new mail stays unread.
//!
//! Shown as an envelope over the taskbar button on Windows (see `tray::show_new_mail`).

use std::collections::HashSet;
use std::sync::Mutex;

/// What turned the badge on. Memory only: like Outlook, a restart starts with it off.
#[derive(Debug, Default)]
struct Pending {
    /// Messages (public ids) whose arrival turned it on.
    messages: HashSet<String>,
    /// Web accounts whose Inbox count went up.
    web: HashSet<String>,
}

impl Pending {
    fn on(&self) -> bool {
        !self.messages.is_empty() || !self.web.is_empty()
    }
}

#[derive(Debug, Default)]
pub struct NewMail(Mutex<Pending>);

impl NewMail {
    fn with<T>(&self, f: impl FnOnce(&mut Pending) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn is_on(&self) -> bool {
        self.with(|p| p.on())
    }

    /// New unread mail arrived in an account's Inbox. Returns whether the badge is on.
    pub fn arrived(&self, ids: impl IntoIterator<Item = String>) -> bool {
        self.with(|p| {
            p.messages.extend(ids);
            p.on()
        })
    }

    /// A web account's Inbox count changed from `old` to `new`. Up means new mail; down means
    /// mail was read in the page (or elsewhere), which counts as reading. A count appearing
    /// for the first time (page loading) is neither. Returns whether the badge changed.
    pub fn web_count(&self, account_id: &str, old: Option<i64>, new: Option<i64>) -> bool {
        let (Some(old), Some(new)) = (old, new) else { return false };
        if new > old {
            self.with(|p| {
                let was = p.on();
                p.web.insert(account_id.to_string());
                !was
            })
        } else if new < old {
            self.read()
        } else {
            false
        }
    }

    /// The user read a message that was unread. Returns whether the badge went off.
    pub fn read(&self) -> bool {
        self.with(|p| {
            let was = p.on();
            *p = Pending::default();
            was
        })
    }

    /// Mail changed. If every message that turned the badge on has since been read (on another
    /// device, say) or removed, turn it off: there's no new mail left to read.
    /// `still_unread` gives those of the ids still stored and unread. Returns whether the
    /// badge went off.
    pub fn prune(&self, still_unread: impl FnOnce(&[String]) -> Vec<String>) -> bool {
        let ids: Vec<String> = self.with(|p| p.messages.iter().cloned().collect());
        if ids.is_empty() {
            return false;
        }
        let left: HashSet<String> = still_unread(&ids).into_iter().collect();
        self.with(|p| {
            let was = p.on();
            // Keep any that arrived while we were looking.
            p.messages.retain(|id| left.contains(id) || !ids.contains(id));
            was && !p.on()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn on_with_new_mail_off_when_read() {
        let b = NewMail::default();
        assert!(!b.is_on());
        assert!(b.arrived(ids(&["a:1"])));
        assert!(b.arrived(ids(&["a:2"])));
        assert!(b.read());
        assert!(!b.is_on());
        assert!(!b.read(), "already off");
    }

    #[test]
    fn stays_on_while_new_mail_is_unread() {
        let b = NewMail::default();
        b.arrived(ids(&["a:1", "a:2"]));
        assert!(!b.prune(|x| x.to_vec()));
        assert!(b.is_on());
        // One of the two read on the phone: still new mail to read.
        assert!(!b.prune(|_| ids(&["a:2"])));
        assert!(b.is_on());
        // Both read (or deleted) elsewhere: off.
        assert!(b.prune(|_| vec![]));
        assert!(!b.is_on());
    }

    #[test]
    fn prune_keeps_mail_that_arrived_meanwhile() {
        let b = NewMail::default();
        b.arrived(ids(&["a:1"]));
        b.prune(|x| {
            b.arrived(ids(&["a:9"]));
            assert_eq!(x, ids(&["a:1"]));
            vec![]
        });
        assert!(b.is_on());
    }

    #[test]
    fn web_counts() {
        let b = NewMail::default();
        assert!(!b.web_count("w", None, Some(4)), "page loading isn't new mail");
        assert!(!b.web_count("w", Some(4), None));
        assert!(!b.web_count("w", Some(4), Some(4)));
        assert!(b.web_count("w", Some(4), Some(5)));
        assert!(!b.web_count("w", Some(5), Some(6)), "already on");
        // Web mail isn't pruned: only a read turns it off.
        assert!(!b.prune(|_| vec![]));
        assert!(b.is_on());
        assert!(b.web_count("w", Some(6), Some(5)));
        assert!(!b.is_on());
        // Reading a message in the app also clears web mail, as any read does.
        b.web_count("w", Some(5), Some(6));
        b.arrived(ids(&["a:1"]));
        assert!(b.read());
        assert!(!b.is_on());
    }
}
