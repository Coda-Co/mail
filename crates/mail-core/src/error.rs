use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// Could not reach the server: the request certainly did not arrive.
    #[error("network: {0}")]
    Network(String),
    /// The request went out but no answer came back: it may or may not have been processed.
    #[error("no response: {0}")]
    NoResponse(String),
    /// The account needs to sign in again.
    #[error("sign-in needed: {0}")]
    Auth(String),
    #[error("Microsoft Graph {status}: {code} {message}")]
    Graph { status: u16, code: String, message: String },
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Network trouble where the request may or may not have reached the server.
    pub fn is_network(&self) -> bool {
        matches!(self, Error::Network(_) | Error::NoResponse(_))
    }
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Graph { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_connect() || e.is_builder() {
            Error::Network(e.to_string())
        } else {
            Error::NoResponse(e.to_string())
        }
    }
}

// Errors cross into the interface as plain messages.
impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
