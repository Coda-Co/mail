import { describe, expect, it } from 'vitest';
import { durationLabel, parseTime, snapDate, snapMinutes } from './timeEntry';

describe('timeEntry', () => {
  it('snaps to quarter hours', () => {
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(52)).toBe(45);
    expect(snapMinutes(53)).toBe(60);
    const d = snapDate(new Date(2026, 11, 17, 14, 8, 41));
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([14, 15, 0]);
  });

  it('reads loosely typed times', () => {
    expect(parseTime('9')).toBe(9 * 60);
    expect(parseTime('930')).toBe(9 * 60 + 30);
    expect(parseTime('09:30')).toBe(9 * 60 + 30);
    expect(parseTime('9.45')).toBe(9 * 60 + 45);
    expect(parseTime('1430')).toBe(14 * 60 + 30);
    expect(parseTime('2pm')).toBe(14 * 60);
    expect(parseTime('2:30 PM')).toBe(14 * 60 + 30);
    expect(parseTime('12am')).toBe(0);
    expect(parseTime('12pm')).toBe(12 * 60);
    expect(parseTime('noon')).toBe(12 * 60);
    expect(parseTime('14h')).toBe(14 * 60);
    // Off the quarter hour: rounded.
    expect(parseTime('10:05')).toBe(10 * 60);
    expect(parseTime('10:10')).toBe(10 * 60 + 15);
    // Never rounds past the end of the day.
    expect(parseTime('23:55')).toBe(23 * 60 + 45);
  });

  it('rejects what isn’t a time', () => {
    for (const t of ['', 'abc', '25', '9:75', '13pm', '0am']) expect(parseTime(t)).toBeNull();
  });

  it('labels durations', () => {
    expect(durationLabel(15)).toBe('15 min');
    expect(durationLabel(60)).toBe('1 h');
    expect(durationLabel(90)).toBe('1 h 30 min');
    expect(durationLabel(1440)).toBe('1 day');
  });
});
