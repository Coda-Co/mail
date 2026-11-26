import { invoke } from '@tauri-apps/api/core';
import type { MailApi } from './types';

// Each MailApi method maps to a Tauri command named in snake_case.
// Arguments are passed as one object keyed by the camelCase parameter names;
// Tauri converts them to the Rust command's snake_case parameters.
const call = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args);

export const tauriApi: MailApi = {
  me: () => call('me'),
  listAccounts: () => call('list_accounts'),
  addAccount: (email) => call('add_account', { email }),
  addWebAccount: (email, displayName) => call('add_web_account', { email, displayName }),
  upgradeWebAccount: (accountId) => call('upgrade_web_account', { accountId }),
  updateAccount: (accountId, patch) => call('update_account', { accountId, patch }),
  removeAccount: (accountId) => call('remove_account', { accountId }),

  listFolders: (accountId) => call('list_folders', { accountId }),
  listMessages: (scope, limit, offset) => call('list_messages', { scope, limit, offset }),
  getThread: (messageId) => call('get_thread', { messageId }),
  getMessage: (messageId) => call('get_message', { messageId }),
  markRead: (ids, read) => call('mark_read', { ids, read }),
  setFlag: (ids, flagged) => call('set_flag', { ids, flagged }),
  archive: (ids) => call('archive', { ids }),
  deleteMessages: (ids) => call('delete_messages', { ids }),
  moveMessages: (ids, folderId) => call('move_messages', { ids, folderId }),
  allowRemoteImages: (senderEmail) => call('allow_remote_images', { senderEmail }),
  showRemoteImagesOnce: (messageId) => call('show_remote_images_once', { messageId }),
  openAttachment: (messageId, attachmentId) => call('open_attachment', { messageId, attachmentId }),
  copyAttachments: (messageId, attachmentIds) => call('copy_attachments', { messageId, attachmentIds }),

  createDraft: (req) => call('create_draft', { req }),
  getDraft: (draftId) => call('get_draft', { draftId }),
  updateDraft: (draft) => call('update_draft', { draft }),
  changeDraftAccount: (draftId, accountId) => call('change_draft_account', { draftId, accountId }),
  setDraftSignature: (draftId, signatureId) => call('set_draft_signature', { draftId, signatureId }),
  addAttachment: (draftId) => call('add_attachment', { draftId }),
  // The bytes go as the raw request body (no JSON encoding); names ride in headers.
  addAttachmentFile: async (draftId, file) =>
    invoke('add_attachment_data', new Uint8Array(await file.arrayBuffer()), {
      headers: { 'x-draft-id': encodeURIComponent(draftId), 'x-file-name': encodeURIComponent(file.name) },
    }),
  removeAttachment: (draftId, attachmentId) => call('remove_attachment', { draftId, attachmentId }),
  discardDraft: (draftId) => call('discard_draft', { draftId }),
  sendDraft: (draftId) => call('send_draft', { draftId }),
  cancelSend: (draftId) => call('cancel_send', { draftId }),

  search: (query) => call('search', { query }),
  searchServer: (query) => call('search_server', { query }),
  listPeople: (query, limit) => call('list_people', { query, limit }),
  getPerson: (email) => call('get_person', { email }),

  listCalendars: () => call('list_calendars'),
  setCalendarVisible: (calendarId, visible) => call('set_calendar_visible', { calendarId, visible }),
  listEvents: (start, end) => call('list_events', { start, end }),
  searchEvents: (query) => call('search_events', { query }),
  agenda: (days) => call('agenda', { days }),
  createEvent: (input) => call('create_event', { input }),
  updateEvent: (eventId, input) => call('update_event', { eventId, input }),
  respondEvent: (eventId, response, options) => call('respond_event', { eventId, response, sendResponse: options?.sendResponse ?? true, comment: options?.comment || null }),
  deleteEvent: (eventId) => call('delete_event', { eventId }),

  listSignatures: (accountId) => call('list_signatures', { accountId }),
  saveSignature: (signature) => call('save_signature', { signature }),
  deleteSignature: (signatureId) => call('delete_signature', { signatureId }),

  getSettings: () => call('get_settings'),
  updateSettings: (patch) => call('update_settings', { patch }),
  syncNow: (accountId) => call('sync_now', { accountId }),
  syncStatus: () => call('sync_status'),
  diskEncryption: () => call('disk_encryption'),

  popOut: (kind, id) => call('pop_out', { kind, id }),
  dockBack: (draftId) => call('dock_back', { draftId }),

  showWebAccount: (accountId, bounds) => call('show_web_account', { accountId, bounds }),
  hideWebAccounts: () => call('hide_web_accounts'),
  reloadWebAccount: (accountId) => call('reload_web_account', { accountId }),
  refreshWebCalendars: () => call('refresh_web_calendars'),
  fetchWebEventAttendees: (accountId, eventId) => call('fetch_web_event_attendees', { accountId, eventId }),
  openWebEvent: (accountId, eventId) => call('open_web_event', { accountId, eventId }),

  openExternal: (url) => call('open_external', { url }),

  updateStatus: () => call('update_status'),
  checkForUpdate: () => call('check_for_update'),
  installUpdate: () => call('install_update'),
};
