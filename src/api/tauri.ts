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
  addAttachment: (draftId) => call('add_attachment', { draftId }),
  removeAttachment: (draftId, attachmentId) => call('remove_attachment', { draftId, attachmentId }),
  discardDraft: (draftId) => call('discard_draft', { draftId }),
  sendDraft: (draftId) => call('send_draft', { draftId }),

  search: (query) => call('search', { query }),
  searchServer: (query) => call('search_server', { query }),
  listPeople: (query, limit) => call('list_people', { query, limit }),
  getPerson: (email) => call('get_person', { email }),

  listCalendars: () => call('list_calendars'),
  setCalendarVisible: (calendarId, visible) => call('set_calendar_visible', { calendarId, visible }),
  listEvents: (start, end) => call('list_events', { start, end }),
  agenda: (days) => call('agenda', { days }),
  createEvent: (input) => call('create_event', { input }),
  updateEvent: (eventId, input) => call('update_event', { eventId, input }),
  respondEvent: (eventId, response) => call('respond_event', { eventId, response }),
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

  openExternal: (url) => call('open_external', { url }),
};
