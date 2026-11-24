//! Files on the system clipboard, so attachments paste into Explorer or Finder.

use clipboard_rs::{Clipboard, ClipboardContext};
use mail_core::Error;
use std::cell::RefCell;

thread_local! {
    // Kept for the life of the app: on Linux the context serves pastes until it is dropped.
    static CONTEXT: RefCell<Option<ClipboardContext>> = const { RefCell::new(None) };
}

/// Call on the main thread.
pub fn set_files(paths: Vec<String>) -> Result<(), Error> {
    CONTEXT.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(ClipboardContext::new().map_err(|e| Error::Other(format!("clipboard: {e}")))?);
        }
        slot.as_ref().unwrap().set_files(paths).map_err(|e| Error::Other(format!("clipboard: {e}")))
    })
}
