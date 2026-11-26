//! Pending operations: local changes waiting to be replayed against the server.
//! All ids are raw ids within the account.

use crate::model::EventResponse;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    MarkRead { ids: Vec<String>, read: bool },
    Flag { ids: Vec<String>, flagged: bool },
    /// destination: raw folder id or a Graph well-known folder name.
    Move { ids: Vec<String>, destination: String },
    DeleteMessages { ids: Vec<String> },
    SaveDraft { draft_id: String },
    DeleteServerDraft { server_id: String },
    Send { draft_id: String },
    CreateEvent { event_id: String },
    UpdateEvent { event_id: String },
    RespondEvent {
        event_id: String,
        response: EventResponse,
        /// Whether the organiser is told. Ops queued before this existed always sent.
        #[serde(default = "yes")]
        send_response: bool,
        /// A note to the organiser with the response.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        comment: Option<String>,
    },
    DeleteEvent { event_id: String },
}

fn yes() -> bool {
    true
}

impl Op {
    pub fn kind(&self) -> &'static str {
        match self {
            Op::MarkRead { .. } => "markRead",
            Op::Flag { .. } => "flag",
            Op::Move { .. } => "move",
            Op::DeleteMessages { .. } => "deleteMessages",
            Op::SaveDraft { .. } => "saveDraft",
            Op::DeleteServerDraft { .. } => "deleteServerDraft",
            Op::Send { .. } => "send",
            Op::CreateEvent { .. } => "createEvent",
            Op::UpdateEvent { .. } => "updateEvent",
            Op::RespondEvent { .. } => "respondEvent",
            Op::DeleteEvent { .. } => "deleteEvent",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serialises_with_draft_id_key() {
        let v = serde_json::to_value(Op::Send { draft_id: "d1".into() }).unwrap();
        assert_eq!(v, serde_json::json!({"op": "send", "draftId": "d1"}));
        let back: Op = serde_json::from_value(v).unwrap();
        assert_eq!(back.kind(), "send");
    }

    #[test]
    fn responses_queued_before_send_response_existed_still_send() {
        let op: Op = serde_json::from_str(r#"{"op":"respondEvent","eventId":"E1","response":"accepted"}"#).unwrap();
        assert_eq!(op, Op::RespondEvent { event_id: "E1".into(), response: EventResponse::Accepted, send_response: true, comment: None });
    }
}
