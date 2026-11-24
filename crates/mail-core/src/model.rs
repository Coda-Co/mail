//! Types shared with the interface. Mirrors `src/api/types.ts` (camelCase JSON).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountKind {
    Graph,
    Web,
}

impl AccountKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountKind::Graph => "graph",
            AccountKind::Web => "web",
        }
    }
    pub fn parse(s: &str) -> Self {
        if s == "web" {
            AccountKind::Web
        } else {
            AccountKind::Graph
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    Idle,
    Syncing,
    Offline,
    Error,
    NeedsAuth,
}

impl SyncState {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncState::Idle => "idle",
            SyncState::Syncing => "syncing",
            SyncState::Offline => "offline",
            SyncState::Error => "error",
            SyncState::NeedsAuth => "needsAuth",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "syncing" => SyncState::Syncing,
            "offline" => SyncState::Offline,
            "error" => SyncState::Error,
            "needsAuth" => SyncState::NeedsAuth,
            _ => SyncState::Idle,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub kind: AccountKind,
    pub color: String,
    pub unread: Option<i64>,
    pub notifications: bool,
    pub offline_months: i64,
    pub sync_state: SyncState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPatch {
    pub display_name: Option<String>,
    pub color: Option<String>,
    pub notifications: Option<bool>,
    pub offline_months: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderRole {
    Inbox,
    Drafts,
    Sent,
    Archive,
    Deleted,
    Junk,
}

impl FolderRole {
    pub const ALL: [FolderRole; 6] = [
        FolderRole::Inbox,
        FolderRole::Drafts,
        FolderRole::Sent,
        FolderRole::Archive,
        FolderRole::Deleted,
        FolderRole::Junk,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            FolderRole::Inbox => "inbox",
            FolderRole::Drafts => "drafts",
            FolderRole::Sent => "sent",
            FolderRole::Archive => "archive",
            FolderRole::Deleted => "deleted",
            FolderRole::Junk => "junk",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "inbox" => FolderRole::Inbox,
            "drafts" => FolderRole::Drafts,
            "sent" => FolderRole::Sent,
            "archive" => FolderRole::Archive,
            "deleted" => FolderRole::Deleted,
            "junk" => FolderRole::Junk,
            _ => return None,
        })
    }
    /// Graph well-known folder name.
    pub fn graph_name(self) -> &'static str {
        match self {
            FolderRole::Inbox => "inbox",
            FolderRole::Drafts => "drafts",
            FolderRole::Sent => "sentitems",
            FolderRole::Archive => "archive",
            FolderRole::Deleted => "deleteditems",
            FolderRole::Junk => "junkemail",
        }
    }
    /// Sort order in the sidebar.
    pub fn order(self) -> i32 {
        match self {
            FolderRole::Inbox => 0,
            FolderRole::Drafts => 1,
            FolderRole::Sent => 2,
            FolderRole::Archive => 3,
            FolderRole::Deleted => 4,
            FolderRole::Junk => 5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub role: Option<FolderRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub unread: i64,
    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Address {
    pub name: String,
    pub email: String,
}

impl Address {
    pub fn new(name: impl Into<String>, email: impl Into<String>) -> Self {
        Address { name: name.into(), email: email.into() }
    }
    pub fn display(&self) -> &str {
        if self.name.trim().is_empty() {
            &self.email
        } else {
            &self.name
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ListTab {
    #[default]
    All,
    Unread,
    Flagged,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FolderSelector {
    Role { role: FolderRole },
    Id { id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub folder: FolderSelector,
    #[serde(default)]
    pub tab: ListTab,
}

impl ViewScope {
    pub fn unified_inbox() -> Self {
        ViewScope { account_id: None, folder: FolderSelector::Role { role: FolderRole::Inbox }, tab: ListTab::All }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub conversation_id: String,
    pub from: Address,
    pub to: Vec<Address>,
    pub subject: String,
    pub snippet: String,
    pub received_at: String,
    pub is_read: bool,
    pub is_flagged: bool,
    pub has_attachments: bool,
    pub is_draft: bool,
    /// The conversation has a reply or forward the user started and hasn't sent.
    #[serde(default)]
    pub has_draft: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub size: i64,
    pub is_inline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    #[serde(flatten)]
    pub summary: MessageSummary,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub body_html: String,
    pub remote_images_blocked: bool,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftMode {
    New,
    Reply,
    ReplyAll,
    Forward,
}

impl DraftMode {
    pub fn as_str(self) -> &'static str {
        match self {
            DraftMode::New => "new",
            DraftMode::Reply => "reply",
            DraftMode::ReplyAll => "replyAll",
            DraftMode::Forward => "forward",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "reply" => DraftMode::Reply,
            "replyAll" => DraftMode::ReplyAll,
            "forward" => DraftMode::Forward,
            _ => DraftMode::New,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftStatus {
    Editing,
    Queued,
    Sending,
    Sent,
    /// The send request went out but its result is unknown. Held; never re-sent automatically.
    Unknown,
    Failed,
}

impl DraftStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DraftStatus::Editing => "editing",
            DraftStatus::Queued => "queued",
            DraftStatus::Sending => "sending",
            DraftStatus::Sent => "sent",
            DraftStatus::Unknown => "unknown",
            DraftStatus::Failed => "failed",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "queued" => DraftStatus::Queued,
            "sending" => DraftStatus::Sending,
            "sent" => DraftStatus::Sent,
            "unknown" => DraftStatus::Unknown,
            "failed" => DraftStatus::Failed,
            _ => DraftStatus::Editing,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub account_id: String,
    pub mode: DraftMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub subject: String,
    pub body_html: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub updated_at: String,
    pub saved_to_server: bool,
    pub status: DraftStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub popped_out: bool,
    /// False for a new draft the user hasn't changed yet (Escape discards those).
    #[serde(default = "edited_default")]
    pub edited: bool,
}

fn edited_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDraftRequest {
    pub mode: DraftMode,
    #[serde(default)]
    pub source_message_id: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub conversation_id: String,
    pub subject: String,
    pub messages: Vec<Message>,
    pub drafts: Vec<Draft>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DateFilter {
    #[default]
    Any,
    Week,
    Month,
    Year,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    #[serde(default)]
    pub text: String,
    pub scope: ViewScope,
    #[serde(default)]
    pub all_folders: bool,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub has_attachment: Option<bool>,
    #[serde(default)]
    pub unread: Option<bool>,
    #[serde(default)]
    pub date: Option<DateFilter>,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub email: String,
    pub name: String,
    pub account_ids: Vec<String>,
    pub message_count: i64,
    pub last_contact_at: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub messages: Vec<MessageSummary>,
    pub total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact: Option<Person>,
    pub from_server: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub color: String,
    pub visible: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ResponseStatus {
    #[default]
    None,
    Organizer,
    Accepted,
    Tentative,
    Declined,
}

impl ResponseStatus {
    pub fn from_graph(s: &str) -> Self {
        match s {
            "organizer" => ResponseStatus::Organizer,
            "accepted" => ResponseStatus::Accepted,
            "tentativelyAccepted" => ResponseStatus::Tentative,
            "declined" => ResponseStatus::Declined,
            _ => ResponseStatus::None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttendeeType {
    Required,
    Optional,
    Resource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub address: Address,
    #[serde(rename = "type")]
    pub kind: AttendeeType,
    pub response: ResponseStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub account_id: String,
    pub calendar_id: String,
    pub subject: String,
    pub start: String,
    pub end: String,
    pub is_all_day: bool,
    pub location: String,
    pub body_html: String,
    pub organizer: Address,
    pub attendees: Vec<Attendee>,
    pub my_response: ResponseStatus,
    pub is_online_meeting: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online_meeting_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder_minutes: Option<i64>,
    pub is_cancelled: bool,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub account_id: String,
    #[serde(default)]
    pub calendar_id: Option<String>,
    pub subject: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub is_all_day: bool,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub body_html: String,
    #[serde(default)]
    pub attendees: Vec<Address>,
    #[serde(default)]
    pub is_online_meeting: bool,
    #[serde(default)]
    pub reminder_minutes: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventResponse {
    Accepted,
    Tentative,
    Declined,
}

impl EventResponse {
    pub fn as_status(self) -> ResponseStatus {
        match self {
            EventResponse::Accepted => ResponseStatus::Accepted,
            EventResponse::Tentative => ResponseStatus::Tentative,
            EventResponse::Declined => ResponseStatus::Declined,
        }
    }
    pub fn graph_action(self) -> &'static str {
        match self {
            EventResponse::Accepted => "accept",
            EventResponse::Tentative => "tentativelyAccept",
            EventResponse::Declined => "decline",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaDay {
    pub label: String,
    pub date: String,
    pub events: Vec<CalendarEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub html: String,
    pub default_new: bool,
    pub default_reply: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub notifications: bool,
    pub ctrl_f: String,
    pub remote_image_senders: Vec<String>,
    /// "show": load remote images (except in Junk); "ask": block until shown or the
    /// sender is allowed. Defaulted so settings saved before it existed still load.
    #[serde(default = "default_remote_images")]
    pub remote_images: String,
}

fn default_remote_images() -> String {
    "show".into()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "light".into(),
            notifications: true,
            ctrl_f: "forward".into(),
            remote_image_senders: vec![],
            remote_images: default_remote_images(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub notifications: Option<bool>,
    pub ctrl_f: Option<String>,
    pub remote_image_senders: Option<Vec<String>>,
    pub remote_images: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub online: bool,
    pub syncing: bool,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    pub outbox_held: i64,
    /// Showing built-in sample data (set by the host in demo mode).
    #[serde(default)]
    pub demo: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiskEncryption {
    On,
    Off,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AddAccountResult {
    Added {
        account: Account,
    },
    #[serde(rename_all = "camelCase")]
    NeedsAdminApproval {
        email: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tenant_id: Option<String>,
        error_code: String,
        admin_consent_url: String,
        request_message: String,
    },
    Cancelled,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me {
    pub name: String,
    pub email: String,
}
