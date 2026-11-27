import { addDays, startOfWeek } from './dates';

/**
 * Days for one month in the sidebar's month overview: whole Monday-first weeks
 * covering the month. With `trimTail` (a month shown directly above the next),
 * the last week stops at the month's end, as the next month picks it up.
 */
export function miniMonthDays(year: number, month: number, trimTail = false): Date[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const start = startOfWeek(first);
  const end = trimTail ? last : addDays(startOfWeek(last), 6);
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}
