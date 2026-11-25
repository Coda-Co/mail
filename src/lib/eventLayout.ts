import type { CalendarEvent } from '../api/types';

export interface Placed {
  event: CalendarEvent;
  lane: number;
  lanes: number;
}

/** Side-by-side lanes for overlapping events in one day. */
export function layoutDay(events: CalendarEvent[]): Placed[] {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  const placed: Placed[] = [];
  let group: Placed[] = [];
  let groupEnd = '';
  const flush = () => {
    const lanes = Math.max(1, ...group.map((p) => p.lane + 1));
    group.forEach((p) => (p.lanes = lanes));
    group = [];
  };
  for (const e of sorted) {
    if (group.length && e.start >= groupEnd) flush();
    const used = new Set(group.filter((p) => p.event.end > e.start).map((p) => p.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    const p = { event: e, lane, lanes: 1 };
    group.push(p);
    placed.push(p);
    if (e.end > groupEnd) groupEnd = e.end;
  }
  flush();
  return placed;
}
