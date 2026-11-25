import { describe, expect, it } from 'vitest';
import { miniMonthDays } from './miniMonth';

describe('miniMonthDays', () => {
  it('covers whole Monday-first weeks', () => {
    const days = miniMonthDays(2026, 11); // December 2026
    expect(days[0].getDate()).toBe(30); // Mon 30 Nov
    expect(days[days.length - 1].getDate()).toBe(3); // Sun 3 Jan
    expect(days.length % 7).toBe(0);
  });

  it('stops at the month end when trimmed', () => {
    const days = miniMonthDays(2026, 10, true); // November 2026
    expect(days[0].getDate()).toBe(26); // Mon 26 Oct
    expect(days[days.length - 1].getDate()).toBe(30); // Mon 30 Nov
  });
});
