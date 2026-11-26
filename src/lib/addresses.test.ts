import { describe, expect, it } from 'vitest';
import { formatAddresses, looksLikeAddresses, mergeAddresses, parseAddresses, removeAddresses } from './addresses';

const ann = { name: 'Ann Lee', email: 'ann@x.com' };
const smith = { name: 'Smith, Jo', email: 'jo@x.com' };
const bare = { name: '', email: 'bo@x.com' };

describe('addresses', () => {
  it('round-trips copied chips, including names with commas and quotes', () => {
    const list = [ann, smith, bare, { name: 'Al "Big" Q', email: 'al@x.com' }];
    expect(parseAddresses(formatAddresses(list))).toEqual(list);
  });

  it('parses mixed separators and newlines', () => {
    expect(parseAddresses('a@x.com; B <b@x.com>\nc@x.com,')).toEqual([
      { name: '', email: 'a@x.com' },
      { name: 'B', email: 'b@x.com' },
      { name: '', email: 'c@x.com' },
    ]);
  });

  it('tells addresses from search text', () => {
    expect(looksLikeAddresses('Ann Lee <ann@x.com>')).toBe(true);
    expect(looksLikeAddresses('ann@x.com')).toBe(true);
    expect(looksLikeAddresses('a@x.com, b@x.com')).toBe(true);
    expect(looksLikeAddresses('Ann')).toBe(false);
    expect(looksLikeAddresses('Ann, Bob')).toBe(false);
  });

  it('merges without duplicates and removes by email', () => {
    expect(mergeAddresses([ann], [{ name: '', email: 'ANN@x.com' }, bare, bare])).toEqual([ann, bare]);
    expect(removeAddresses([ann, smith, bare], [{ name: '', email: 'JO@x.com' }])).toEqual([ann, bare]);
  });
});
