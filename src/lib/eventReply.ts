import type { Address, CalendarEvent } from '../api/types';

export type EventReplyMode = 'reply' | 'replyAll';

export interface EventReply {
  to: Address[];
  cc: Address[];
  subject: string;
}

/** "Re: <subject>", without stacking prefixes. */
export function eventReplySubject(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Who an email about an event goes to. Reply goes to the organiser; reply all goes to the
 * organiser and required attendees, with optional attendees on Cc. You and rooms are left out.
 * When you organised it, reply goes to everyone you invited, like reply all.
 */
export function eventReply(event: CalendarEvent, myEmail: string, mode: EventReplyMode): EventReply {
  const me = myEmail.trim().toLowerCase();
  const seen = new Set<string>();
  const take = (a: Address) => {
    const key = a.email.trim().toLowerCase();
    if (!key || key === me || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const organizer = event.organizer.email ? event.organizer : event.attendees.find((a) => a.response === 'organizer')?.address;
  const iOrganised = !organizer || organizer.email.trim().toLowerCase() === me;
  const to: Address[] = [];
  const cc: Address[] = [];
  if (organizer && take(organizer)) to.push({ ...organizer });
  if (mode === 'replyAll' || iOrganised) {
    for (const a of event.attendees) {
      if (a.type === 'resource' || a.response === 'organizer') continue;
      if (!take(a.address)) continue;
      (a.type === 'optional' ? cc : to).push({ ...a.address });
    }
  }
  return { to, cc, subject: eventReplySubject(event.subject) };
}

/** Whether there's anyone besides you to email about the event. */
export function canReplyToEvent(event: CalendarEvent, myEmail: string): boolean {
  const r = eventReply(event, myEmail, 'replyAll');
  return r.to.length + r.cc.length > 0;
}

/** Whether reply all reaches more people than reply. */
export function replyAllDiffers(event: CalendarEvent, myEmail: string): boolean {
  const one = eventReply(event, myEmail, 'reply');
  const all = eventReply(event, myEmail, 'replyAll');
  return all.to.length + all.cc.length > one.to.length + one.cc.length;
}
