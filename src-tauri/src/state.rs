use mail_core::auth::{AuthConfig, Tokens};
use mail_core::graph::{GraphClient, GRAPH_BASE};
use mail_core::model::Account;
use mail_core::secrets::TokenStore;
use mail_core::sync::ClientFactory;
use mail_core::{Error, MailService, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Keychain / Credential Manager service name.
pub const KEYRING_SERVICE: &str = "co.coda.mail";

pub struct AppState {
    pub svc: Arc<MailService>,
    pub wake: Arc<tokio::sync::Notify>,
    pub auth: AuthConfig,
    pub tokens: Arc<dyn TokenStore>,
    token_cache: Arc<Mutex<HashMap<String, Arc<Tokens>>>>,
    pub http: reqwest::Client,
    pub graph_base: String,
    pub demo: bool,
}

/// The app registration's client id: build-time `MAIL_APP_CLIENT_ID`, overridable at run time.
pub fn client_id() -> String {
    std::env::var("MAIL_APP_CLIENT_ID").ok().or_else(|| option_env!("MAIL_APP_CLIENT_ID").map(String::from)).unwrap_or_default()
}

impl AppState {
    pub fn new(svc: Arc<MailService>, demo: bool) -> Self {
        let tokens: Arc<dyn TokenStore> = if demo {
            Arc::new(mail_core::secrets::MemoryTokenStore::default())
        } else {
            Arc::new(mail_core::secrets::OsKeyring::new(KEYRING_SERVICE))
        };
        AppState {
            svc,
            wake: Arc::new(tokio::sync::Notify::new()),
            auth: AuthConfig::new(client_id()),
            tokens,
            token_cache: Arc::new(Mutex::new(HashMap::new())),
            http: GraphClient::http(),
            graph_base: std::env::var("MAIL_APP_GRAPH_BASE").unwrap_or_else(|_| GRAPH_BASE.to_string()),
            demo,
        }
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
