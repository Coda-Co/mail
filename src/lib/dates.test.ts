import { describe, expect, it } from 'vitest';
import { agoTime } from './dates';

describe('agoTime', () => {
  const ref = new Date(2026, 10, 23, 9, 50);
  const at = (h: number, m: number, day = 23) => new Date(2026, 10, day, h, m).toISOString();

  it('says just now inside a minute', () => expect(agoTime(new Date(ref.getTime() - 20_000).toISOString(), ref)).toBe('just now'));
  it('counts minutes inside an hour', () => expect(agoTime(at(9, 46), ref)).toBe('4 min ago'));
  it('gives the time earlier today', () => expect(agoTime(at(7, 5), ref)).toBe('at 07:05'));
  it('says yesterday', () => expect(agoTime(at(18, 30, 22), ref)).toBe('yesterday at 18:30'));
  it('gives the date before that', () => expect(agoTime(at(18, 30, 19), ref)).toBe('on Thu 19 Nov, 18:30'));
});
