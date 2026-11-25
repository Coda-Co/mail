import type { Account } from '../api/types';

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** Two mailboxes belong to the same organisation if they share a tenant or a domain. */
export function sameOrg(a: Account, b: Account): boolean {
  return (!!a.tenantId && a.tenantId === b.tenantId) || domainOf(a.email) === domainOf(b.email);
}

const firstLetter = (s: string) => (s.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

/**
 * The letters on a mailbox's glyph in the rail: the organisation's initial,
 * plus the mailbox's own initial when the user has more than one mailbox there.
 */
export function glyphLetters(account: Account, all: Account[]): { org: string; mailbox?: string } {
  const org = firstLetter(account.displayName || domainOf(account.email));
  const shared = all.some((o) => o.id !== account.id && sameOrg(o, account));
  return shared ? { org, mailbox: firstLetter(account.email).toLowerCase() } : { org };
}
