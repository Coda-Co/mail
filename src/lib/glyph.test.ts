import { describe, expect, it } from 'vitest';
import type { Account } from '../api/types';
import { glyphLetters } from './glyph';

const acc = (id: string, email: string, displayName: string, tenantId?: string): Account => ({
  id,
  email,
  displayName,
  tenantId,
  kind: 'graph',
  color: '#000',
  unread: 0,
  notifications: true,
  offlineMonths: 6,
  syncState: 'idle',
  webCalendar: false,
});

describe('glyphLetters', () => {
  it('uses the organisation initial alone when it has one mailbox', () => {
    const a = acc('a', 'miles@coda.example', 'Coda & Co', 't1');
    const b = acc('b', 'm@fenwick.example', 'Fenwick Group', 't2');
    expect(glyphLetters(a, [a, b])).toEqual({ org: 'C' });
  });

  it('adds the mailbox initial when the organisation has several, by tenant or domain', () => {
    const a = acc('a', 'miles@coda.example', 'Coda & Co', 't1');
    const b = acc('b', 'support@coda.example', 'Coda Support');
    const c = acc('c', 'hello@coda.co', 'Coda', 't1');
    expect(glyphLetters(a, [a, b, c])).toEqual({ org: 'C', mailbox: 'm' });
    expect(glyphLetters(b, [a, b, c])).toEqual({ org: 'C', mailbox: 's' });
    expect(glyphLetters(c, [a, b, c])).toEqual({ org: 'C', mailbox: 'h' });
  });

  it('skips punctuation in names', () => {
    const a = acc('a', 'x@y.example', '& Partners');
    expect(glyphLetters(a, [a]).org).toBe('P');
  });
});
