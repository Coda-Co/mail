//! Files on the system clipboard, so attachments paste into Explorer or Finder, and files
//! copied there paste into a draft.

use clipboard_rs::{Clipboard, ClipboardContext};
use mail_core::Error;
use std::cell::RefCell;
use std::path::PathBuf;

thread_local! {
    // Kept for the life of the app: on Linux the context serves pastes until it is dropped.
    static CONTEXT: RefCell<Option<ClipboardContext>> = const { RefCell::new(None) };
}

fn with_context<T>(f: impl FnOnce(&ClipboardContext) -> Result<T, Error>) -> Result<T, Error> {
    CONTEXT.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(ClipboardContext::new().map_err(|e| Error::Other(format!("clipboard: {e}")))?);
        }
        f(slot.as_ref().unwrap())
    })
}

/// Call on the main thread.
pub fn set_files(paths: Vec<String>) -> Result<(), Error> {
    with_context(|c| c.set_files(paths).map_err(|e| Error::Other(format!("clipboard: {e}"))))
}

/// The files on the clipboard as local paths; empty when it holds none. Call on the main thread.
pub fn get_files() -> Result<Vec<PathBuf>, Error> {
    // Windows reports "no files" as an error; treat any failure to read the list the same way.
    let raw = with_context(|c| Ok(c.get_files().unwrap_or_default()))?;
    Ok(raw.iter().filter_map(|s| to_path(s)).collect())
}

/// Windows and macOS give plain paths; Linux gives percent-encoded `file://` URIs.
fn to_path(s: &str) -> Option<PathBuf> {
    let s = s.trim();
    match s.strip_prefix("file://") {
        // Drop any host part ("file://host/path"); local files have none or "localhost".
        Some(rest) => {
            let path = &rest[rest.find('/')?..];
            Some(PathBuf::from(urlencoding::decode(path).ok()?.into_owned()))
        }
        None if s.is_empty() => None,
        None => Some(PathBuf::from(s)),
    }
}

#[cfg(test)]
mod tests {
    use super::to_path;
    use std::path::PathBuf;

    #[test]
    fn paths_from_clipboard_entries() {
        assert_eq!(to_path("file:///home/me/My%20Report.pdf"), Some(PathBuf::from("/home/me/My Report.pdf")));
        assert_eq!(to_path("file://localhost/tmp/a.txt"), Some(PathBuf::from("/tmp/a.txt")));
        assert_eq!(to_path(r"C:\Users\me\a.txt"), Some(PathBuf::from(r"C:\Users\me\a.txt")));
        assert_eq!(to_path("/Users/me/a b.txt"), Some(PathBuf::from("/Users/me/a b.txt")));
        assert_eq!(to_path("  "), None);
    }
}
