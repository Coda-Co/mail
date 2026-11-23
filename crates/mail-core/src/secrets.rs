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

#[cfg(feature = "os-keyring")]
pub struct OsKeyring {
    service: String,
}

#[cfg(feature = "os-keyring")]
impl OsKeyring {
    pub fn new(service: &str) -> Self {
        OsKeyring { service: service.into() }
    }
    fn entry(&self, id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, id).map_err(|e| Error::Other(format!("credential store: {e}")))
    }
}

#[cfg(feature = "os-keyring")]
impl TokenStore for OsKeyring {
    fn get(&self, id: &str) -> Result<Option<String>> {
        match self.entry(id)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Other(format!("credential store: {e}"))),
        }
    }
    fn set(&self, id: &str, t: &str) -> Result<()> {
        self.entry(id)?.set_password(t).map_err(|e| Error::Other(format!("credential store: {e}")))
    }
    fn delete(&self, id: &str) -> Result<()> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Other(format!("credential store: {e}"))),
        }
    }
}
