// Times for events: quarter hours only, typed loosely.

export const STEP_MIN = 15;

/** Round to the nearest quarter hour (down when exactly between). */
export function snapMinutes(min: number): number {
  return Math.round(min / STEP_MIN) * STEP_MIN;
}

/** The same day at a quarter hour: seconds dropped, minutes rounded. */
export function snapDate(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  const m = snapMinutes(out.getHours() * 60 + out.getMinutes());
  out.setHours(0, m, 0, 0);
  return out;
}

/**
 * Minutes after midnight from what someone typed: "9", "930", "09:30", "9.30", "9:30pm", "2pm",
 * "14h", "noon", "midnight". Snapped to a quarter hour. null when it isn't a time.
 */
export function parseTime(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return null;
  if (t === 'noon' || t === 'midday') return 12 * 60;
  if (t === 'midnight') return 0;
  const m = t.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?h?(am|pm|a|p)?$/) ?? t.match(/^(\d{1,2})(\d{2})(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3];
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm.startsWith('p') && h !== 12) h += 12;
    if (ampm.startsWith('a') && h === 12) h = 0;
  } else if (h > 23) return null;
  return Math.min(snapMinutes(h * 60 + min), 24 * 60 - STEP_MIN);
}

/** "15 min", "1 h", "1 h 30 min", "1 day". */
export function durationLabel(min: number): string {
  if (min > 0 && min % 1440 === 0) return min === 1440 ? '1 day' : `${min / 1440} days`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
