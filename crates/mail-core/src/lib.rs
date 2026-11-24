//! mail-core: everything except the window. Storage, Microsoft Graph sync, search,
//! people, drafts and the outbox, used by the desktop app.

pub mod auth;
pub mod db;
pub mod demo;
pub mod disk;
pub mod error;
pub mod graph;
pub mod html;
pub mod ids;
pub mod model;
pub mod ops;
pub mod people;
pub mod secrets;
pub mod service;
pub mod sync;
pub mod text;
pub mod webcal;

pub use error::{Error, Result};
pub use service::{EventSink, MailService};
