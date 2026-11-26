use mail_core::auth::{AuthConfig, Tokens};
use mail_core::graph::{GraphClient, GRAPH_BASE};
use mail_core::model::Account;
use mail_core::secrets::TokenStore;
use mail_core::sync::ClientFactory;
use mail_core::{Error, MailService, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub svc: Arc<MailService>,
    pub wake: Arc<tokio::sync::Notify>,
    /// Wakes the outbox loop: something was sent or changed and should go now.
    pub outbox: Arc<tokio::sync::Notify>,
    pub auth: AuthConfig,
    pub tokens: Arc<dyn TokenStore>,
    token_cache: Arc<Mutex<HashMap<String, Arc<Tokens>>>>,
    pub http: reqwest::Client,
    pub graph_base: String,
    pub demo: bool,
    /// Bumped by each local search; a search that is no longer the latest stops early.
    pub search_gen: Arc<std::sync::atomic::AtomicU64>,
}

/// Coda & Co's multi-tenant app registration (docs/APP_REGISTRATION.md). Not a secret:
/// public clients have no secret, and the id appears in every sign-in URL.
pub const CLIENT_ID: &str = "190e0115-8a14-44c2-9bbc-af0704d1ded6";

/// The client id to sign in with: `MAIL_APP_CLIENT_ID` (at run time, then at build time)
/// overrides the built-in registration, e.g. to try a test registration.
pub fn client_id() -> String {
    std::env::var("MAIL_APP_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("MAIL_APP_CLIENT_ID").map(String::from))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| CLIENT_ID.to_string())
}

impl AppState {
    /// `identifier` doubles as the Keychain / Credential Manager service name, so dev and
    /// release builds keep separate sign-ins.
    pub fn new(svc: Arc<MailService>, demo: bool, identifier: &str) -> Self {
        let tokens: Arc<dyn TokenStore> = if demo {
            Arc::new(mail_core::secrets::MemoryTokenStore::default())
        } else {
            Arc::new(mail_core::secrets::os_token_store(identifier))
        };
        AppState {
            svc,
            wake: Arc::new(tokio::sync::Notify::new()),
            outbox: Arc::new(tokio::sync::Notify::new()),
            auth: AuthConfig::new(client_id()),
            tokens,
            token_cache: Arc::new(Mutex::new(HashMap::new())),
            http: GraphClient::http(),
            graph_base: std::env::var("MAIL_APP_GRAPH_BASE").unwrap_or_else(|_| GRAPH_BASE.to_string()),
            demo,
            search_gen: Arc::default(),
        }
    }

    /// Sync status for the interface, flagged when showing sample data.
    pub fn sync_status(&self) -> Result<mail_core::model::SyncStatus> {
        let mut st = self.svc.sync_status()?;
        if self.demo {
            st.demo = true;
            st.label = "Sample data · nothing syncs".into();
        }
        Ok(st)
    }

    pub fn tokens_for(&self, account: &Account) -> Arc<Tokens> {
        token_entry(&self.token_cache, &self.http, &self.auth, &self.tokens, account)
    }

    pub fn graph(&self, account: &Account) -> Result<GraphClient> {
        if self.demo {
            return Err(Error::Invalid("Not available in the demo".into()));
        }
        Ok(GraphClient::new(self.http.clone(), self.graph_base.clone(), self.tokens_for(account)))
    }

    pub fn forget_tokens(&self, account_id: &str) {
        self.token_cache.lock().unwrap().remove(account_id);
        let _ = self.tokens.delete(account_id);
    }

    pub fn client_factory(&self) -> ClientFactory {
        let cache = self.token_cache.clone();
        let http = self.http.clone();
        let auth = self.auth.clone();
        let store = self.tokens.clone();
        let base = self.graph_base.clone();
        Arc::new(move |a: &Account| Ok(GraphClient::new(http.clone(), base.clone(), token_entry(&cache, &http, &auth, &store, a))))
    }
}

fn token_entry(cache: &Mutex<HashMap<String, Arc<Tokens>>>, http: &reqwest::Client, auth: &AuthConfig, store: &Arc<dyn TokenStore>, a: &Account) -> Arc<Tokens> {
    cache
        .lock()
        .unwrap()
        .entry(a.id.clone())
        .or_insert_with(|| Arc::new(Tokens::refreshing(http.clone(), auth.clone(), a.tenant_id.clone(), &a.id, store.clone())))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_client_id_is_a_guid() {
        let parts: Vec<&str> = CLIENT_ID.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(CLIENT_ID.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
        assert!(AuthConfig::new(CLIENT_ID).is_configured());
    }
}
