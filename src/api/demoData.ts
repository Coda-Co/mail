// Sample data for the demo backend, taken from the mockups in design/.
// All names and companies are made up. Times are relative to the pinned demo
// "now" (Mon 23 Nov 2026, 09:50 local).

import type { Account, Address, Attachment, CalendarEvent, CalendarInfo, Folder, FolderRole, Message, Signature } from './types';
import { textToHtml } from '../lib/text';

export interface DemoState {
  version: number;
  me: { name: string; email: string };
  accounts: Account[];
  folders: Folder[];
  messages: Message[];
  drafts: import('./types').Draft[];
  calendars: CalendarInfo[];
  events: CalendarEvent[];
  signatures: Signature[];
  settings: import('./types').Settings;
  serverOnly: Message[];
}

export const DEMO_VERSION = 6;

const COLORS = { coda: '#1F883D', harbour: '#8250DF', fenwick: '#D4600F', aldgate: '#6E7781' };

type AccKey = 'coda' | 'harbour' | 'fenwick';

const ME_ADDR: Record<AccKey, Address> = {
  coda: { name: 'Miles Rowland', email: 'miles@coda.example' },
  harbour: { name: 'Miles Rowland', email: 'miles.rowland@harbourpartners.example' },
  fenwick: { name: 'Miles Rowland', email: 'm.rowland@fenwickgroup.example' },
};

const PEOPLE: Record<string, Address> = {
  sarah: { name: 'Sarah Okafor', email: 'sarah.okafor@harbourpartners.example' },
  james: { name: 'James Hart', email: 'james.hart@harbourpartners.example' },
  tom: { name: 'Tom Reid', email: 'tom@coda.example' },
  priya: { name: 'Priya Nair', email: 'priya.nair@fenwickgroup.example' },
  linear: { name: 'Linear', email: 'notifications@linear.example' },
  elena: { name: 'Elena Marsh', email: 'elena@marshadvisory.example' },
  hannah: { name: 'Hannah Cole', email: 'hannah@coda.example' },
  ravi: { name: 'Ravi Shah', email: 'ravi.shah@fenwickgroup.example' },
  xero: { name: 'Xero', email: 'messaging@xero.example' },
  ollie: { name: 'Ollie Grant', email: 'ollie@coda.example' },
  maya: { name: 'Maya Lund', email: 'maya.lund@harbourpartners.example' },
};

function at(base: Date, dayOffset: number, h: number, m: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, m);
  return d.toISOString();
}

let seq = 0;
const id = (prefix: string) => `${prefix}-${(++seq).toString(36)}`;

export function buildDemoState(now: Date): DemoState {
  seq = 0;
  const accounts: Account[] = [
    { id: 'acc-coda', email: ME_ADDR.coda.email, displayName: 'Coda & Co', kind: 'graph', color: COLORS.coda, unread: 0, notifications: true, offlineMonths: 6, syncState: 'idle', lastSyncedAt: now.toISOString(), tenantId: 'coda', webCalendar: false },
    { id: 'acc-harbour', email: ME_ADDR.harbour.email, displayName: 'Harbour Partners', kind: 'graph', color: COLORS.harbour, unread: 0, notifications: true, offlineMonths: 6, syncState: 'idle', lastSyncedAt: now.toISOString(), tenantId: 'harbour', webCalendar: false },
    { id: 'acc-fenwick', email: ME_ADDR.fenwick.email, displayName: 'Fenwick Group', kind: 'graph', color: COLORS.fenwick, unread: 0, notifications: true, offlineMonths: 3, syncState: 'idle', lastSyncedAt: now.toISOString(), tenantId: 'fenwick', webCalendar: false },
    { id: 'acc-aldgate', email: 'miles.rowland@aldgatecapital.example', displayName: 'Aldgate Capital', kind: 'web', color: COLORS.aldgate, unread: 2, notifications: true, offlineMonths: 0, syncState: 'idle', webUrl: 'https://outlook.office.com/mail/', webCalendar: true, webCalendarSyncedAt: new Date(now.getTime() - 4 * 60000).toISOString() },
  ];
  const accId = (k: AccKey) => `acc-${k}`;

  const roles: [FolderRole, string][] = [
    ['inbox', 'Inbox'],
    ['drafts', 'Drafts'],
    ['sent', 'Sent'],
    ['archive', 'Archive'],
    ['deleted', 'Deleted'],
    ['junk', 'Junk'],
  ];
  const folders: Folder[] = [];
  for (const k of ['coda', 'harbour', 'fenwick'] as AccKey[]) {
    for (const [role, name] of roles) folders.push({ id: `${k}-${role}`, accountId: accId(k), name, role, unread: 0, total: 0 });
  }
  folders.push({ id: 'coda-clients', accountId: 'acc-coda', name: 'Clients', role: null, unread: 0, total: 0 });
  folders.push({ id: 'coda-clients-harbour', accountId: 'acc-coda', name: 'Harbour', role: null, parentId: 'coda-clients', unread: 0, total: 0 });
  folders.push({ id: 'coda-finance', accountId: 'acc-coda', name: 'Finance', role: null, unread: 0, total: 0 });

  const messages: Message[] = [];
  const add = (
    acc: AccKey,
    folder: FolderRole | string,
    from: Address,
    when: string,
    subject: string,
    body: string,
    opts: { unread?: boolean; flagged?: boolean; attachments?: string[]; to?: Address[]; cc?: Address[]; conversation?: string; images?: boolean } = {},
  ) => {
    const folderId = folder.includes('-') ? folder : `${acc}-${folder}`;
    const attachments: Attachment[] = (opts.attachments ?? []).map((name) => ({
      id: id('att'),
      name,
      contentType: name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 48_000 + name.length * 3100,
      isInline: false,
    }));
    let bodyHtml = textToHtml(body);
    if (opts.images) bodyHtml = `<p><img src="https://images.example/newsletter-header.png" alt="Header" width="560" height="120"></p>` + bodyHtml;
    const firstPara = body.split('\n').filter(Boolean);
    const snippetSource = firstPara.length > 1 && /^(hi|hello|dear)\b/i.test(firstPara[0]) ? firstPara.slice(0, 2).join(' ') : firstPara.join(' ');
    const m: Message = {
      id: id('msg'),
      accountId: accId(acc),
      folderId,
      conversationId: opts.conversation ?? id('conv'),
      from,
      to: opts.to ?? [ME_ADDR[acc]],
      cc: opts.cc ?? [],
      bcc: [],
      replyTo: [],
      subject,
      snippet: snippetSource.slice(0, 140),
      receivedAt: when,
      isRead: !opts.unread,
      isFlagged: !!opts.flagged,
      hasAttachments: attachments.length > 0,
      isDraft: false,
      bodyHtml,
      remoteImagesBlocked: !!opts.images,
      attachments,
    };
    messages.push(m);
    return m;
  };

  // The six messages in the Main mockup.
  const sarahMsg = add('harbour', 'inbox', PEOPLE.sarah, at(now, 0, 9, 42), 'Agenda for Thursday’s steering committee',
    'Hi Miles,\n\nAttaching the draft agenda for Thursday. Could you take the AI roadmap item? Twenty minutes should be plenty, with time for questions at the end.\n\nWe’ll be in the large meeting room on the third floor; I’ll send dial-in details for anyone joining remotely.\n\nThanks,\nSarah',
    { unread: true, attachments: ['Steering committee agenda.docx'], cc: [PEOPLE.james] });
  sarahMsg.snippet = 'Hi Miles, attaching the draft agenda. Could you take the AI roadmap item?';
  add('coda', 'inbox', PEOPLE.tom, at(now, 0, 9, 15), 'November invoice draft',
    'Hi Miles,\n\nThe November draft is ready for review before it goes to Xero. Let me know if anything needs changing.\n\nTom', { unread: true }).snippet = 'Draft is ready for review before it goes to Xero.';
  add('fenwick', 'inbox', PEOPLE.priya, at(now, 0, 8, 50), 'Data warehouse access request',
    'Hi Miles,\n\nIT have approved read access for your account from Monday. You’ll get a separate email with the connection details.\n\nPriya', { unread: true }).snippet = 'IT have approved read access for your account from Monday.';
  add('coda', 'inbox', PEOPLE.linear, at(now, 0, 8, 2), '3 issues assigned to you',
    'You have 3 new issues assigned to you this morning.\n\nEvaluation harness, and 2 more.', { images: true }).snippet = 'Evaluation harness, and 2 more.';
  // A conversation of several messages (two in the inbox, Miles's reply in Sent).
  add('harbour', 'inbox', PEOPLE.sarah, at(now, -1, 11, 2), 'Re: Portfolio scan next steps',
    'Thanks both. I’ve narrowed it to three options; the shortlist is in the shared folder.\n\nSarah', { to: [ME_ADDR.harbour, PEOPLE.james], conversation: 'conv-portfolio' });
  add('harbour', 'inbox', PEOPLE.james, at(now, -1, 18, 20), 'Re: Portfolio scan next steps',
    'Agree with the shortlist. Let’s pick it up on Thursday.\n\nJames', { flagged: true, conversation: 'conv-portfolio' });
  add('coda', 'inbox', PEOPLE.elena, at(now, -6, 17, 5), 'Intro: Elena / Miles', 'Great to be connected. Would a call next week work?\n\nElena', { flagged: true });

  // Older unread mail so the counts match the sidebar in the mockup (8 / 3 / 1).
  const older: [AccKey, Address, number, string, string][] = [
    ['coda', PEOPLE.hannah, -8, 'Team offsite: venue options', 'Three venues shortlisted for January. Could you rank them by Friday?\n\nHannah'],
    ['coda', PEOPLE.ollie, -9, 'Evaluation harness write-up', 'First draft of the write-up is in the shared folder. Comments welcome.\n\nOllie'],
    ['coda', PEOPLE.xero, -10, 'Bills to approve', 'You have 4 bills waiting for approval.'],
    ['coda', PEOPLE.hannah, -12, 'Q1 planning doc', 'Dropped the Q1 planning doc into the drive. Main open question is hiring.\n\nHannah'],
    ['coda', PEOPLE.ollie, -13, 'Expenses for October', 'Could you approve my October expenses when you get a moment?\n\nOllie'],
    ['coda', PEOPLE.tom, -14, 'Pipeline review', 'Updated the pipeline sheet with last week’s calls.\n\nTom'],
    ['coda', PEOPLE.hannah, -15, 'Website copy review', 'Could you look over the new services page before it goes live?\n\nHannah'],
    ['harbour', PEOPLE.maya, -9, 'Data room access', 'You should now have access to the data room. Shout if not.\n\nMaya'],
    ['harbour', PEOPLE.james, -11, 'Board pack timings', 'Board pack is due on the 4th; can we have the AI section by the 1st?\n\nJames'],
  ];
  for (const [acc, from, day, subject, body] of older) add(acc, 'inbox', from, at(now, day, 11, 10 + day * -1), subject, body, { unread: true });

  // Steering committee history (Search mockup).
  add('harbour', 'archive', PEOPLE.sarah, at(new Date(2026, 10, 12), 0, 14, 5), 'Steering committee: date moved',
    'We’ve moved the November steering committee to Thursday 26th. Same room.\n\nSarah').snippet = 'We’ve moved the November steering committee to Thursday 26th.';
  add('harbour', 'archive', PEOPLE.sarah, at(new Date(2026, 9, 29), 0, 16, 30), 'October steering pack',
    'Pack attached for reference ahead of the session.\n\nSarah', { attachments: ['October steering pack.pdf'] });
  add('harbour', 'archive', PEOPLE.james, at(now, -3, 12, 0), 'Re: Steering committee prep', 'Happy for you to lead on the AI section.\n\nJames');
  add('coda', 'coda-clients-harbour', PEOPLE.tom, at(new Date(2026, 10, 3), 0, 10, 0), 'Steering notes for Harbour', 'Notes from the last session, tidied up.\n\nTom', { attachments: ['Notes.docx'] });

  // Longer history with Sarah and others, so people ranking has something to work with.
  const history: [AccKey, Address, string][] = [
    ['harbour', PEOPLE.sarah, 'Portfolio scan: first findings'],
    ['harbour', PEOPLE.sarah, 'Workshop follow-up'],
    ['harbour', PEOPLE.sarah, 'Re: Statement of work'],
    ['harbour', PEOPLE.sarah, 'Invoice query'],
    ['harbour', PEOPLE.sarah, 'Interview slots'],
    ['harbour', PEOPLE.sarah, 'AI policy draft'],
    ['harbour', PEOPLE.sarah, 'Re: AI policy draft'],
    ['harbour', PEOPLE.sarah, 'Data platform options'],
    ['harbour', PEOPLE.sarah, 'Christmas schedule'],
    ['harbour', PEOPLE.sarah, 'Supplier shortlist'],
    ['harbour', PEOPLE.sarah, 'Re: Supplier shortlist'],
    ['harbour', PEOPLE.sarah, 'Quick question on scope'],
    ['harbour', PEOPLE.sarah, 'Thanks for today'],
    ['harbour', PEOPLE.james, 'Portfolio scan next steps'],
    ['harbour', PEOPLE.james, 'Budget sign-off'],
    ['coda', PEOPLE.tom, 'October invoice draft'],
    ['coda', PEOPLE.tom, 'Harbour timesheets'],
    ['coda', PEOPLE.hannah, 'Hiring plan'],
    ['fenwick', PEOPLE.priya, 'Kick-off notes'],
    ['fenwick', PEOPLE.ravi, 'Warehouse design: requirements'],
    ['fenwick', PEOPLE.ravi, 'Re: Warehouse design: requirements'],
  ];
  history.forEach(([acc, from, subject], i) => {
    add(acc, 'archive', from, at(now, -20 - i * 6, 10 + (i % 6), (i * 7) % 60), subject, `${subject}.\n\nNotes and next steps below; nothing urgent.\n\n${from.name.split(' ')[0]}`);
  });

  // Sent mail.
  add('harbour', 'sent', ME_ADDR.harbour, at(now, -1, 17, 40), 'Re: Portfolio scan next steps', 'Shortlist attached. Happy to go through it on Thursday.\n\nMiles', { to: [PEOPLE.james, PEOPLE.sarah], conversation: 'conv-portfolio' });
  add('coda', 'sent', ME_ADDR.coda, at(now, -2, 9, 5), 'Re: Q1 planning doc', 'Thanks Hannah, I’ll add comments by Wednesday.\n\nMiles', { to: [PEOPLE.hannah] });
  add('fenwick', 'sent', ME_ADDR.fenwick, at(now, -4, 15, 0), 'Data warehouse access', 'Hi Priya, could you request read access to the warehouse for me?\n\nThanks,\nMiles', { to: [PEOPLE.priya] });

  // Messages only on the server (beyond the offline window), for "Search the server".
  const serverOnly: Message[] = [];
  const old = add('harbour', 'archive', PEOPLE.sarah, at(new Date(2025, 10, 20), 0, 11, 0), 'Steering committee: terms of reference', 'Terms of reference for the steering committee, as agreed last year.\n\nSarah', { attachments: ['Terms of reference.pdf'] });
  messages.splice(messages.indexOf(old), 1);
  serverOnly.push(old);

  const signatures: Signature[] = [
    { id: 'sig-coda', accountId: 'acc-coda', name: 'Coda & Co', html: '<p><b>Miles Rowland</b><br>Director, Coda &amp; Co<br><a href="https://coda.example">coda.example</a></p>', defaultNew: true, defaultReply: true },
    { id: 'sig-coda-short', accountId: 'acc-coda', name: 'Short', html: '<p>Miles</p>', defaultNew: false, defaultReply: false },
    { id: 'sig-harbour', accountId: 'acc-harbour', name: 'Harbour Partners', html: '<p><b>Miles Rowland</b><br>AI advisor to Harbour Partners</p>', defaultNew: true, defaultReply: false },
  ];

  // Calendar: the week in the Calendar mockup.
  const calendars: CalendarInfo[] = [
    { id: 'cal-coda', accountId: 'acc-coda', name: 'Calendar', color: COLORS.coda, visible: true, isDefault: true, readOnly: false },
    { id: 'cal-harbour', accountId: 'acc-harbour', name: 'Calendar', color: COLORS.harbour, visible: true, isDefault: true, readOnly: false },
    { id: 'cal-fenwick', accountId: 'acc-fenwick', name: 'Calendar', color: COLORS.fenwick, visible: true, isDefault: true, readOnly: false },
    // Read from Outlook on the web: read-only.
    { id: 'cal-aldgate', accountId: 'acc-aldgate', name: 'Calendar', color: COLORS.aldgate, visible: true, isDefault: true, readOnly: true },
  ];
  const monday = new Date(2026, 10, 23);
  const ev = (
    acc: AccKey,
    day: number,
    start: number,
    end: number,
    subject: string,
    location: string,
    opts: { online?: boolean; organizer?: Address; attendees?: Address[]; response?: CalendarEvent['myResponse']; extra?: number } = {},
  ): CalendarEvent => {
    const s = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day, Math.floor(start), Math.round((start % 1) * 60));
    const e = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day, Math.floor(end), Math.round((end % 1) * 60));
    const organizer = opts.organizer ?? ME_ADDR[acc];
    const isMine = organizer.email === ME_ADDR[acc].email;
    const attendees = (opts.attendees ?? []).map((a) => ({
      address: a,
      type: 'required' as const,
      response: a.email === organizer.email ? ('organizer' as const) : a.email === ME_ADDR[acc].email ? (opts.response ?? 'none') : ('accepted' as const),
    }));
    for (let i = 0; i < (opts.extra ?? 0); i++) attendees.push({ address: { name: `Guest ${i + 1}`, email: `guest${i + 1}@harbourpartners.example` }, type: 'required', response: 'none' });
    return {
      id: id('evt'),
      accountId: accId(acc),
      calendarId: `cal-${acc}`,
      subject,
      start: s.toISOString(),
      end: e.toISOString(),
      isAllDay: false,
      location,
      bodyHtml: opts.online ? teamsBody(subject) : '',
      organizer,
      attendees,
      myResponse: isMine ? 'organizer' : (opts.response ?? 'none'),
      isOnlineMeeting: !!opts.online,
      onlineMeetingUrl: opts.online ? 'https://teams.example/meet/123' : undefined,
      reminderMinutes: 15,
      isCancelled: false,
      color: COLORS[acc],
      readOnly: false,
    };
  };
  // The block Teams puts in every invitation, under the organiser's own note.
  const teamsBody = (subject: string) => {
    const rule = '<div style="width:100%"><span style="white-space:nowrap;color:#5F5F5F;opacity:.36">________________________________________________________________________________</span></div>';
    return `<p>Agenda for ${subject}: quick round of updates, then decisions.</p>${rule}<div class="me-email-text"><div style="margin-bottom:24px"><span style="font-size:24px;font-weight:700">Microsoft Teams meeting</span></div><div><span style="font-size:20px">Join: </span><a href="https://teams.example/meet/123" style="font-size:20px">https://teams.example/meet/123?p=rdBnCmNugvFQFhxj00</a></div><div>Meeting ID: 347 497 567 667 899</div></div>${rule}`;
  };
  const ALDGATE_ME: Address = { name: 'Miles Rowland', email: 'miles.rowland@aldgatecapital.example' };
  const ana: Address = { name: 'Ana Silva', email: 'ana.silva@aldgatecapital.example' };
  // Web account events, as read from Outlook on the web: no body, no reminder, read-only.
  const webEv = (day: number, start: number, end: number, subject: string, location: string, response: CalendarEvent['myResponse'], allDay = false): CalendarEvent => {
    const d = (h: number) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day, Math.floor(h), Math.round((h % 1) * 60));
    return {
      id: id('web'),
      accountId: 'acc-aldgate',
      calendarId: 'cal-aldgate',
      subject,
      start: (allDay ? d(0) : d(start)).toISOString(),
      end: (allDay ? new Date(d(0).getTime() + 86400000) : d(end)).toISOString(),
      isAllDay: allDay,
      location,
      bodyHtml: '',
      organizer: ana,
      attendees: [
        { address: ana, type: 'required', response: 'organizer' },
        { address: ALDGATE_ME, type: 'required', response },
      ],
      myResponse: response,
      isOnlineMeeting: location === '',
      onlineMeetingUrl: location === '' ? 'https://teams.example/meet/aldgate' : undefined,
      isCancelled: false,
      color: COLORS.aldgate,
      readOnly: true,
    };
  };
  const events: CalendarEvent[] = [
    ev('coda', 0, 9, 9.5, 'Weekly delivery', '', { online: true, attendees: [ME_ADDR.coda, PEOPLE.tom, PEOPLE.hannah, PEOPLE.ollie] }),
    ev('coda', 0, 11, 12.5, 'Client workshop prep', '', { attendees: [ME_ADDR.coda, PEOPLE.hannah] }),
    ev('fenwick', 0, 14, 15, 'Data review', '', { online: true, organizer: PEOPLE.priya, attendees: [PEOPLE.priya, ME_ADDR.fenwick, PEOPLE.ravi], response: 'accepted' }),
    ev('fenwick', 1, 10, 12, 'Warehouse design session', '', { online: true, organizer: PEOPLE.ravi, attendees: [PEOPLE.ravi, ME_ADDR.fenwick, PEOPLE.priya], response: 'accepted' }),
    ev('coda', 1, 15, 15.5, 'Intro call: Elena Marsh', '', { online: true, attendees: [ME_ADDR.coda, PEOPLE.elena] }),
    ev('harbour', 2, 9.5, 10.5, 'Portfolio scan check-in', '', { online: true, organizer: PEOPLE.james, attendees: [PEOPLE.james, ME_ADDR.harbour], response: 'accepted' }),
    ev('coda', 2, 13, 16, 'Focus time', ''),
    ev('harbour', 3, 10, 12, 'Steering committee', 'Large meeting room, 3rd floor', { organizer: PEOPLE.sarah, attendees: [PEOPLE.sarah, PEOPLE.james, ME_ADDR.harbour], response: 'accepted', extra: 4 }),
    ev('harbour', 3, 12.5, 13, 'Debrief', '', { online: true, organizer: PEOPLE.james, attendees: [PEOPLE.james, ME_ADDR.harbour], response: 'accepted' }),
    ev('coda', 4, 9, 10, 'Invoicing', ''),
    ev('coda', 4, 16, 17, 'Mentor chat', '', { online: true, attendees: [ME_ADDR.coda, { name: 'Dana Wells', email: 'dana@mentoring.example' }] }),
    ev('coda', 7, 9, 9.5, 'Weekly delivery', '', { online: true, attendees: [ME_ADDR.coda, PEOPLE.tom, PEOPLE.hannah, PEOPLE.ollie] }),
    ev('harbour', 8, 14, 15, 'AI policy review', '', { online: true, organizer: PEOPLE.sarah, attendees: [PEOPLE.sarah, ME_ADDR.harbour], response: 'none' }),
    ev('fenwick', 9, 10, 11, 'Warehouse build kick-off', 'Fenwick HQ, room 2', { organizer: PEOPLE.ravi, attendees: [PEOPLE.ravi, ME_ADDR.fenwick], response: 'none' }),
    ev('coda', -7, 9, 9.5, 'Weekly delivery', '', { online: true, attendees: [ME_ADDR.coda, PEOPLE.tom] }),
    webEv(1, 13, 14, 'Investment committee', 'Aldgate boardroom', 'accepted'),
    webEv(7, 14, 15, 'Quarterly portfolio review', '', 'none'),
    webEv(9, 0, 0, 'Aldgate offsite', 'Cambridge', 'accepted', true),
    ev('coda', 9, 9.5, 10.5, 'Proposal review', '', { online: true, attendees: [ME_ADDR.coda, PEOPLE.tom] }),
  ];

  // A meeting request: the reading pane shows when it is, beside the rest of that day.
  const kickoff = events.find((e) => e.subject === 'Warehouse build kick-off')!;
  const invite = add(
    'fenwick',
    'inbox',
    PEOPLE.ravi,
    at(now, -6, 15, 10),
    'Warehouse build kick-off',
    'Hi all,\n\nKicking off the warehouse build. We’ll walk through the plan, owners and the first two sprints.\n\nRavi',
    { cc: [PEOPLE.priya] },
  );
  invite.meeting = { kind: 'request', start: kickoff.start, end: kickoff.end, isAllDay: false, location: kickoff.location, eventId: kickoff.id };

  return {
    version: DEMO_VERSION,
    me: { name: 'Miles Rowland', email: ME_ADDR.coda.email },
    accounts,
    folders,
    messages,
    drafts: [],
    calendars,
    events,
    signatures,
    settings: { theme: 'light', notifications: true, ctrlF: 'forward', remoteImageSenders: [], remoteImages: 'show', workStart: 9 * 60, workEnd: 18 * 60 },
    serverOnly,
  };
}
