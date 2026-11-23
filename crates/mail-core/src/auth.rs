//! Microsoft sign-in: OAuth 2.0 authorisation code with PKCE in the system browser,
//! loopback redirect, refresh tokens in the OS credential store. Detects the
//! "Need admin approval" errors so the interface can offer the three ways forward.

use crate::error::{Error, Result};
use crate::secrets::TokenStore;
use base64::Engine;
use rand::Rng;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const SCOPES: &[&str] = &["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"];

/// AADSTS codes that mean the tenant needs an admin to approve the app.
pub const ADMIN_CONSENT_CODES: &[&str] = &["AADSTS90093", "AADSTS90094", "AADSTS90095", "AADSTS900941"];

#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// Our multi-tenant public client registration.
    pub client_id: String,
    pub authority: String,
    /// "organizations" (work and school accounts).
    pub tenant: String,
    pub scopes: Vec<String>,
    /// Where the admin security note lives (linked from "Ask my admin").
    pub security_note_url: String,
}

impl AuthConfig {
    pub fn new(client_id: impl Into<String>) -> Self {
        AuthConfig {
            client_id: client_id.into(),
            authority: "https://login.microsoftonline.com".into(),
            tenant: "organizations".into(),
            scopes: SCOPES.iter().map(|s| s.to_string()).collect(),
            // Public link to docs/SECURITY.md for client admins; set when building (MAIL_APP_SECURITY_NOTE_URL).
            security_note_url: option_env!("MAIL_APP_SECURITY_NOTE_URL").unwrap_or("").into(),
        }
    }
    fn scope(&self) -> String {
        self.scopes.join(" ")
    }
    pub fn is_configured(&self) -> bool {
        !self.client_id.trim().is_empty() && !self.client_id.contains("REPLACE")
    }
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

fn random_string(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

impl Pkce {
    pub fn new() -> Self {
        let verifier = random_string(64);
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Pkce { verifier, challenge, state: random_string(24) }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

pub fn authorize_url(cfg: &AuthConfig, pkce: &Pkce, redirect_uri: &str, login_hint: &str) -> String {
    let mut u = url::Url::parse(&format!("{}/{}/oauth2/v2.0/authorize", cfg.authority, cfg.tenant)).expect("authority url");
    u.query_pairs_mut()
        .append_pair("client_id", &cfg.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_mode", "query")
        .append_pair("scope", &cfg.scope())
        .append_pair("state", &pkce.state)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("login_hint", login_hint)
        .append_pair("prompt", "select_account");
    u.to_string()
}

/// Tenant-wide admin consent. `tenant` may be a tenant id or a verified domain.
pub fn admin_consent_url(cfg: &AuthConfig, tenant: &str, redirect_uri: &str) -> String {
    let mut u = url::Url::parse(&format!("{}/{}/v2.0/adminconsent", cfg.authority, tenant)).expect("authority url");
    u.query_pairs_mut()
        .append_pair("client_id", &cfg.client_id)
        .append_pair("scope", &cfg.scopes.iter().filter(|s| *s != "offline_access").map(|s| format!("https://graph.microsoft.com/{s}")).collect::<Vec<_>>().join(" "))
        .append_pair("redirect_uri", redirect_uri);
    u.to_string()
}

pub fn admin_request_message(email: &str, consent_url: &str, security_note_url: &str) -> String {
    let note = if security_note_url.is_empty() { String::new() } else { format!("What it requests, where data lives and how to revoke it: {security_note_url}\n\n") };
    format!(
        "Hi,\n\nI'd like to use our mail app with my {email} mailbox. It needs a one-off approval from a Microsoft 365 admin before it can sign in.\n\n\
         It asks for delegated access only (my own mail and calendar; no application permissions and no access to anyone else's mailbox).\n\n\
         Approve here: {consent_url}\n\n{note}Thanks"
    )
}

pub fn consent_error_code(text: &str) -> Option<&'static str> {
    // Longest first so AADSTS900941 is not read as AADSTS90094.
    let mut codes = ADMIN_CONSENT_CODES.to_vec();
    codes.sort_by_key(|c| std::cmp::Reverse(c.len()));
    codes.into_iter().find(|c| text.contains(c))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Redirect {
    Code(String),
    Error { error: String, description: String },
}

/// A loopback listener for the redirect. Bound before the browser opens.
pub struct Loopback {
    listener: TcpListener,
    pub port: u16,
}

impl Loopback {
    pub async fn bind() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        Ok(Loopback { listener, port })
    }

    /// Entra ID allows any port on http://localhost for public clients.
    pub fn redirect_uri(&self) -> String {
        format!("http://localhost:{}", self.port)
    }

    /// Wait for the browser to come back with ?code= or ?error=.
    pub async fn wait(self, expected_state: &str, timeout: Duration) -> Result<Redirect> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Error::Auth("Sign-in timed out".into()));
            }
            let (mut sock, _) = tokio::time::timeout(left, self.listener.accept()).await.map_err(|_| Error::Auth("Sign-in timed out".into()))??;
            let mut buf = vec![0u8; 16 * 1024];
            let n = tokio::time::timeout(Duration::from_secs(10), sock.read(&mut buf)).await.map_err(|_| Error::Auth("Browser did not respond".into()))??;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/").to_string();
            let url = url::Url::parse(&format!("http://localhost{target}")).map_err(|e| Error::Auth(e.to_string()))?;
            let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
            if url.path() != "/" || (!q.contains_key("code") && !q.contains_key("error")) {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let state_ok = q.get("state").map(|s| s == expected_state).unwrap_or(false);
            let (title, body) = if q.contains_key("code") && state_ok {
                ("Signed in", "You're signed in. You can close this tab and go back to Mail.")
            } else {
                ("Sign-in didn't finish", "You can close this tab and go back to Mail.")
            };
            let page = format!(
                "<!doctype html><meta charset=utf-8><title>{title}</title><body style=\"font:16px system-ui;color:#1F2328;display:grid;place-items:center;height:90vh\"><div><h1 style=\"font-size:20px\">{title}</h1><p>{body}</p></div>"
            );
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", page.len(), page);
            let _ = sock.write_all(resp.as_bytes()).await;
            if let Some(err) = q.get("error") {
                return Ok(Redirect::Error { error: err.clone(), description: q.get("error_description").cloned().unwrap_or_default() });
            }
            if !state_ok {
                return Err(Error::Auth("Sign-in response did not match this request".into()));
            }
            return Ok(Redirect::Code(q.get("code").cloned().unwrap_or_default()));
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenError {
    error: String,
    #[serde(default)]
    error_description: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct IdClaims {
    #[serde(default)]
    pub tid: Option<String>,
    #[serde(default)]
    pub oid: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub preferred_username: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Instant,
    pub claims: IdClaims,
}

/// The id token came straight from the token endpoint over TLS, so its claims are read without
/// verifying the signature; it is only used for display and the tenant id.
pub fn decode_id_claims(id_token: &str) -> IdClaims {
    id_token
        .split('.')
        .nth(1)
        .and_then(|p| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

async fn token_request(http: &reqwest::Client, cfg: &AuthConfig, tenant: &str, form: &[(&str, &str)]) -> Result<TokenSet> {
    let url = format!("{}/{}/oauth2/v2.0/token", cfg.authority, tenant);
    let resp = http.post(url).form(form).send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        let e: TokenError = serde_json::from_str(&text).unwrap_or(TokenError { error: status.to_string(), error_description: text.clone() });
        if let Some(code) = consent_error_code(&e.error_description) {
            return Err(Error::Graph { status: status.as_u16(), code: code.into(), message: e.error_description });
        }
        return Err(Error::Auth(format!("{}: {}", e.error, e.error_description.lines().next().unwrap_or(""))));
    }
    let t: TokenResponse = serde_json::from_str(&text)?;
    Ok(TokenSet {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: Instant::now() + Duration::from_secs(t.expires_in.unwrap_or(3600).saturating_sub(120)),
        claims: t.id_token.as_deref().map(decode_id_claims).unwrap_or_default(),
    })
}

pub async fn exchange_code(http: &reqwest::Client, cfg: &AuthConfig, code: &str, verifier: &str, redirect_uri: &str) -> Result<TokenSet> {
    let scope = cfg.scope();
    token_request(
        http,
        cfg,
        &cfg.tenant,
        &[
            ("client_id", cfg.client_id.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
            ("scope", scope.as_str()),
        ],
    )
    .await
}

pub async fn refresh(http: &reqwest::Client, cfg: &AuthConfig, tenant: &str, refresh_token: &str) -> Result<TokenSet> {
    let scope = cfg.scope();
    token_request(
        http,
        cfg,
        tenant,
        &[("client_id", cfg.client_id.as_str()), ("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("scope", scope.as_str())],
    )
    .await
}

#[derive(Debug)]
pub enum SignIn {
    Success(TokenSet),
    NeedsAdmin { code: String, description: String },
    Cancelled,
}

/// Full interactive sign-in. `open_browser` opens the URL in the system browser.
pub async fn sign_in(http: &reqwest::Client, cfg: &AuthConfig, email: &str, open_browser: impl FnOnce(&str) -> Result<()>) -> Result<SignIn> {
    if !cfg.is_configured() {
        return Err(Error::Auth("No app registration configured. Set MAIL_APP_CLIENT_ID when building.".into()));
    }
    let lb = Loopback::bind().await?;
    let redirect = lb.redirect_uri();
    let pkce = Pkce::new();
    open_browser(&authorize_url(cfg, &pkce, &redirect, email))?;
    match lb.wait(&pkce.state, Duration::from_secs(300)).await? {
        Redirect::Code(code) => match exchange_code(http, cfg, &code, &pkce.verifier, &redirect).await {
            Ok(t) => Ok(SignIn::Success(t)),
            Err(Error::Graph { code, message, .. }) => Ok(SignIn::NeedsAdmin { code, description: message }),
            Err(e) => Err(e),
        },
        Redirect::Error { error, description } => {
            if let Some(code) = consent_error_code(&description) {
                Ok(SignIn::NeedsAdmin { code: code.into(), description })
            } else if error == "access_denied" && !description.contains("AADSTS") {
                Ok(SignIn::Cancelled)
            } else if error == "access_denied" && description.contains("AADSTS65004") {
                // The user declined consent.
                Ok(SignIn::Cancelled)
            } else {
                Err(Error::Auth(format!("{error}: {}", description.lines().next().unwrap_or(""))))
            }
        }
    }
}

/// Access tokens for one account, refreshed from the credential store as needed.
pub struct Tokens {
    mode: Mode,
    cache: tokio::sync::Mutex<Option<(String, Instant)>>,
}

enum Mode {
    Static(String),
    Refresh { http: reqwest::Client, cfg: AuthConfig, tenant: String, account_id: String, store: Arc<dyn TokenStore> },
}

impl Tokens {
    pub fn fixed(token: &str) -> Self {
        Tokens { mode: Mode::Static(token.into()), cache: tokio::sync::Mutex::new(None) }
    }

    pub fn refreshing(http: reqwest::Client, cfg: AuthConfig, tenant: Option<String>, account_id: &str, store: Arc<dyn TokenStore>) -> Self {
        let tenant = tenant.unwrap_or_else(|| cfg.tenant.clone());
        Tokens { mode: Mode::Refresh { http, cfg, tenant, account_id: account_id.into(), store }, cache: tokio::sync::Mutex::new(None) }
    }

    /// Seed with the access token from an interactive sign-in.
    pub async fn seed(&self, t: &TokenSet) {
        *self.cache.lock().await = Some((t.access_token.clone(), t.expires_at));
    }

    pub async fn access_token(&self) -> Result<String> {
        match &self.mode {
            Mode::Static(t) => Ok(t.clone()),
            Mode::Refresh { http, cfg, tenant, account_id, store } => {
                let mut cache = self.cache.lock().await;
                if let Some((t, exp)) = cache.as_ref() {
                    if Instant::now() < *exp {
                        return Ok(t.clone());
                    }
                }
                let rt = store.get(account_id)?.ok_or_else(|| Error::Auth("Not signed in".into()))?;
                let t = match refresh(http, cfg, tenant, &rt).await {
                    Ok(t) => t,
                    Err(Error::Graph { code, .. }) => return Err(Error::Auth(format!("Admin approval needed ({code})"))),
                    Err(e) => return Err(e),
                };
                if let Some(new_rt) = &t.refresh_token {
                    store.set(account_id, new_rt)?;
                }
                *cache = Some((t.access_token.clone(), t.expires_at));
                Ok(t.access_token)
            }
        }
    }

    pub async fn invalidate(&self) {
        *self.cache.lock().await = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let p = Pkce::new();
        assert_eq!(p.verifier.len(), 64);
        let expect = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(p.verifier.as_bytes()));
        assert_eq!(p.challenge, expect);
    }

    #[test]
    fn urls() {
        let cfg = AuthConfig::new("client-123");
        let p = Pkce::new();
        let u = authorize_url(&cfg, &p, "http://localhost:5555", "miles@coda.example");
        assert!(u.starts_with("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?"));
        assert!(u.contains("code_challenge_method=S256"));
        assert!(u.contains("login_hint=miles%40coda.example"));
        assert!(u.contains("offline_access"));
        let c = admin_consent_url(&cfg, "harbour.example", "http://localhost:5555");
        assert!(c.starts_with("https://login.microsoftonline.com/harbour.example/v2.0/adminconsent?client_id=client-123"));
        assert!(c.contains("Mail.ReadWrite"));
        assert!(!c.contains("offline_access"));
    }

    #[test]
    fn admin_message() {
        let m = admin_request_message("miles@harbour.example", "https://login.example/consent", "");
        assert!(m.contains("https://login.example/consent") && !m.contains("revoke"));
        assert!(admin_request_message("a@b.example", "u", "https://note.example").contains("https://note.example"));
    }

    #[test]
    fn consent_codes() {
        assert_eq!(consent_error_code("AADSTS90094: The grant requires admin permission."), Some("AADSTS90094"));
        assert_eq!(consent_error_code("AADSTS900941: Administrator consent is required."), Some("AADSTS900941"));
        assert_eq!(consent_error_code("AADSTS50126: Invalid username or password."), None);
    }

    #[test]
    fn id_claims() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"tid":"t1","oid":"o1","name":"Miles Rowland","preferred_username":"miles@coda.example"}"#);
        let c = decode_id_claims(&format!("h.{payload}.s"));
        assert_eq!(c.tid.as_deref(), Some("t1"));
        assert_eq!(c.name.as_deref(), Some("Miles Rowland"));
    }

    #[tokio::test]
    async fn loopback_gets_code_and_rejects_wrong_state() {
        let lb = Loopback::bind().await.unwrap();
        let port = lb.port;
        let task = tokio::spawn(lb.wait("st8", Duration::from_secs(5)));
        let http = reqwest::Client::new();
        let _ = http.get(format!("http://127.0.0.1:{port}/favicon.ico")).send().await;
        let page = http.get(format!("http://127.0.0.1:{port}/?code=abc&state=st8")).send().await.unwrap().text().await.unwrap();
        assert!(page.contains("signed in"));
        assert_eq!(task.await.unwrap().unwrap(), Redirect::Code("abc".into()));

        let lb = Loopback::bind().await.unwrap();
        let port = lb.port;
        let task = tokio::spawn(lb.wait("st8", Duration::from_secs(5)));
        let _ = http.get(format!("http://127.0.0.1:{port}/?error=invalid_client&error_description=AADSTS90094%3A+admin")).send().await;
        match task.await.unwrap().unwrap() {
            Redirect::Error { description, .. } => assert_eq!(consent_error_code(&description), Some("AADSTS90094")),
            r => panic!("{r:?}"),
        }
    }
}
