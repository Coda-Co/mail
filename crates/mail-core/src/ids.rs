//! Public IDs are `<accountId>:<rawId>` so the interface can address any message,
//! draft, event or folder without knowing which account database holds it.
//! Graph IDs are base64url and never contain ':'; account IDs are generated here.

use crate::error::{Error, Result};

pub fn join(account_id: &str, raw: &str) -> String {
    format!("{account_id}:{raw}")
}

pub fn split(id: &str) -> Result<(&str, &str)> {
    id.split_once(':').filter(|(a, r)| !a.is_empty() && !r.is_empty()).ok_or_else(|| Error::NotFound(format!("bad id {id}")))
}

pub fn new_account_id() -> String {
    // Short, readable and safe in file names.
    let u = uuid::Uuid::new_v4().simple().to_string();
    format!("acc{}", &u[..12])
}

pub fn new_local_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let id = join("acc1", "AAMk-_=");
        assert_eq!(split(&id).unwrap(), ("acc1", "AAMk-_="));
        assert!(split("nocolon").is_err());
        assert!(split(":x").is_err());
    }
}
