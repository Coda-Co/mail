//! Refresh tokens live in the OS credential store (Keychain, Credential Manager),
//! never in the databases.

#[cfg(feature = "os-keyring")]
use crate::error::Error;
use crate::error::Result;
use std::collections::HashMap;
use std::sync::Mutex;

pub trait TokenStore: Send + Sync {
    fn get(&self, account_id: &str) -> Result<Option<String>>;
    fn set(&self, account_id: &str, refresh_token: &str) -> Result<()>;
    fn delete(&self, account_id: &str) -> Result<()>;
}

#[derive(Default)]
pub struct MemoryTokenStore(Mutex<HashMap<String, String>>);

impl TokenStore for MemoryTokenStore {
    fn get(&self, id: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn set(&self, id: &str, t: &str) -> Result<()> {
        self.0.lock().unwrap().insert(id.into(), t.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<()> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

/// Byte storage with a size limit per entry (the OS credential stores).
pub trait RawSecrets: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    fn set(&self, key: &str, value: &[u8]) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}

/// Bytes per entry. Windows Credential Manager allows 2560 bytes per credential;
/// Microsoft refresh tokens are often longer, so tokens are split across entries.
pub const CHUNK: usize = 2000;

/// A token store that splits each token across `<id>.0`, `<id>.1`, … with a
/// `chunks:N` header under `<id>`. A plain value under `<id>` is read as a whole token.
pub struct Chunked<R>(pub R);

fn header_count(head: &[u8]) -> Option<usize> {
    std::str::from_utf8(head).ok()?.strip_prefix("chunks:")?.parse().ok()
}

impl<R: RawSecrets> TokenStore for Chunked<R> {
    fn get(&self, id: &str) -> Result<Option<String>> {
        let Some(head) = self.0.get(id)? else { return Ok(None) };
        let bytes = match header_count(&head) {
            Some(n) => {
                let mut out = Vec::new();
                for i in 0..n {
                    match self.0.get(&format!("{id}.{i}"))? {
                        Some(part) => out.extend(part),
                        // Incomplete: treat as signed out rather than use a broken token.
                        None => return Ok(None),
                    }
                }
                out
            }
            None => head,
        };
        Ok(String::from_utf8(bytes).ok())
    }

    fn set(&self, id: &str, token: &str) -> Result<()> {
        self.delete(id)?;
        let parts: Vec<&[u8]> = token.as_bytes().chunks(CHUNK).collect();
        for (i, part) in parts.iter().enumerate() {
            self.0.set(&format!("{id}.{i}"), part)?;
        }
        // Header last, so a half-written token is never read as complete.
        self.0.set(id, format!("chunks:{}", parts.len()).as_bytes())
    }

    fn delete(&self, id: &str) -> Result<()> {
        if let Some(n) = self.0.get(id)?.as_deref().and_then(header_count) {
            for i in 0..n {
                self.0.delete(&format!("{id}.{i}"))?;
            }
        }
        self.0.delete(id)
    }
}

#[cfg(feature = "os-keyring")]
pub struct OsKeyring {
    service: String,
}

/// Refresh tokens in Keychain / Credential Manager, split to fit Windows' size limit.
#[cfg(feature = "os-keyring")]
pub fn os_token_store(service: &str) -> Chunked<OsKeyring> {
    Chunked(OsKeyring { service: service.into() })
}

#[cfg(feature = "os-keyring")]
impl OsKeyring {
    fn entry(&self, key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, key).map_err(|e| Error::Other(format!("credential store: {e}")))
    }
}

#[cfg(feature = "os-keyring")]
impl RawSecrets for OsKeyring {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match self.entry(key)?.get_secret() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Other(format!("credential store: {e}"))),
        }
    }
    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        self.entry(key)?.set_secret(value).map_err(|e| Error::Other(format!("credential store: {e}")))
    }
    fn delete(&self, key: &str) -> Result<()> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Other(format!("credential store: {e}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Behaves like Windows Credential Manager: rejects entries over 2560 bytes.
    #[derive(Default)]
    struct Limited(Mutex<HashMap<String, Vec<u8>>>);
    impl RawSecrets for Limited {
        fn get(&self, k: &str) -> Result<Option<Vec<u8>>> {
            Ok(self.0.lock().unwrap().get(k).cloned())
        }
        fn set(&self, k: &str, v: &[u8]) -> Result<()> {
            if v.len() > 2560 {
                return Err(crate::error::Error::Other("too long".into()));
            }
            self.0.lock().unwrap().insert(k.into(), v.to_vec());
            Ok(())
        }
        fn delete(&self, k: &str) -> Result<()> {
            self.0.lock().unwrap().remove(k);
            Ok(())
        }
    }

    #[test]
    fn long_tokens_are_split_and_reassembled() {
        let store = Chunked(Limited::default());
        let token: String = (0..5000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        store.set("acc1", &token).unwrap();
        assert_eq!(store.get("acc1").unwrap().as_deref(), Some(token.as_str()));
        assert_eq!(store.0 .0.lock().unwrap().len(), 4, "header + 3 parts");
        // Replacing with a shorter token leaves no stale parts.
        store.set("acc1", "short").unwrap();
        assert_eq!(store.get("acc1").unwrap().as_deref(), Some("short"));
        assert_eq!(store.0 .0.lock().unwrap().len(), 2);
        store.delete("acc1").unwrap();
        assert!(store.0 .0.lock().unwrap().is_empty());
        assert_eq!(store.get("acc1").unwrap(), None);
    }

    #[test]
    fn plain_values_and_missing_parts() {
        let store = Chunked(Limited::default());
        store.0.set("old", b"whole-token").unwrap();
        assert_eq!(store.get("old").unwrap().as_deref(), Some("whole-token"));
        store.set("acc2", &"x".repeat(4500)).unwrap();
        store.0.delete("acc2.1").unwrap();
        assert_eq!(store.get("acc2").unwrap(), None, "incomplete tokens read as signed out");
    }
}
