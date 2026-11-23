import { beforeEach, describe, expect, it } from 'vitest';
import { demoApi, resetDemo } from './demo';
import type { SearchQuery, ViewScope } from './types';

const inbox: ViewScope = { folder: { role: 'inbox' }, tab: 'all' };
const q = (patch: Partial<SearchQuery>): SearchQuery => ({ text: '', scope: inbox, allFolders: false, ...patch });

describe('demo backend', () => {
  beforeEach(() => resetDemo());

  it('unified inbox matches the mockup counts', async () => {
    const accounts = await demoApi.listAccounts();
    const counts = Object.fromEntries(accounts.map((a) => [a.displayName, a.unread]));
    expect(counts).toEqual({ 'Coda & Co': 8, 'Harbour Partners': 3, 'Fenwick Group': 1, 'Aldgate Capital': 2 });
    const list = await demoApi.listMessages(inbox, 6, 0);
    expect(list.map((m) => m.from.name)).toEqual(['Sarah Okafor', 'Tom Reid', 'Priya Nair', 'Linear', 'James Hart', 'Elena Marsh']);
  });

  it('search filters the inbox and widens to all folders', async () => {
    const inInbox = await demoApi.search(q({ text: 'steering' }));
    expect(inInbox.messages.map((m) => m.subject)).toEqual(['Agenda for Thursday’s steering committee']);
    const all = await demoApi.search(q({ text: 'steering', allFolders: true, from: 'sarah.okafor@harbourpartners.example' }));
    expect(all.messages.map((m) => m.subject)).toEqual([
      'Agenda for Thursday’s steering committee',
      'Steering committee: date moved',
      'October steering pack',
    ]);
    expect(all.contact?.name).toBe('Sarah Okafor');
  });

  it('facets narrow results', async () => {
    const r = await demoApi.search(q({ text: 'steering', allFolders: true, hasAttachment: true }));
    expect(r.messages.every((m) => m.hasAttachments)).toBe(true);
    const unread = await demoApi.search(q({ unread: true }));
    expect(unread.total).toBe(12);
  });

  it('searching the server adds older results', async () => {
    const r = await demoApi.searchServer(q({ text: 'terms of reference', allFolders: true }));
    expect(r.fromServer).toBe(true);
    expect(r.messages).toHaveLength(1);
  });

  it('ranks frequent recent correspondents first', async () => {
    const people = await demoApi.listPeople('', 3);
    expect(people[0].name).toBe('Sarah Okafor');
  });

  it('groups the agenda into Today, Tomorrow and weekdays', async () => {
    const days = await demoApi.agenda(5);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Tomorrow', 'Wednesday', 'Thursday', 'Friday']);
    // 09:50 on Monday: the 09:00 stand-up is over.
    expect(days[0].events.map((e) => e.subject)).toEqual(['Client workshop prep', 'Data review']);
    expect(days[3].events.map((e) => e.subject)).toEqual(['Steering committee', 'Debrief']);
  });

  it('replies go to the sender from the receiving account, with that account’s reply signature', async () => {
    const [sarah] = await demoApi.listMessages(inbox, 1, 0);
    const d = await demoApi.createDraft({ mode: 'replyAll', sourceMessageId: sarah.id });
    expect(d.accountId).toBe('acc-harbour');
    expect(d.to.map((a) => a.name)).toEqual(['Sarah Okafor']);
    expect(d.cc.map((a) => a.name)).toEqual(['James Hart']);
    expect(d.subject).toBe('RE: Agenda for Thursday’s steering committee');
    expect(d.bodyHtml).toBe(''); // Harbour has no reply signature
    const swapped = await demoApi.changeDraftAccount(d.id, 'acc-coda');
    expect(swapped.bodyHtml).toContain('data-signature="sig-coda"');
    const thread = await demoApi.getThread(sarah.id);
    expect(thread.drafts.map((x) => x.id)).toEqual([d.id]);
  });

  it('sending files the message in Sent and removes the draft', async () => {
    const d = await demoApi.createDraft({ mode: 'new', accountId: 'acc-coda' });
    await expect(demoApi.sendDraft(d.id)).rejects.toThrow(/recipient/);
    await demoApi.updateDraft({ ...d, to: [{ name: 'Tom Reid', email: 'tom@coda.example' }], subject: 'Hello' });
    const sent = await demoApi.sendDraft(d.id);
    expect(sent.status).toBe('sent');
    const list = await demoApi.listMessages({ accountId: 'acc-coda', folder: { role: 'sent' }, tab: 'all' }, 5, 0);
    expect(list[0].subject).toBe('Hello');
  });

  it('archive moves to the account’s Archive and undo restores', async () => {
    const [first] = await demoApi.listMessages(inbox, 1, 0);
    await demoApi.archive([first.id]);
    expect((await demoApi.listMessages(inbox, 50, 0)).some((m) => m.id === first.id)).toBe(false);
    await demoApi.moveMessages([first.id], first.folderId);
    expect((await demoApi.listMessages(inbox, 50, 0)).some((m) => m.id === first.id)).toBe(true);
  });
});
