// Dark mode for message bodies. Most HTML mail pins its own colours (Outlook on the web
// writes `color: rgb(0, 0, 0)` on every paragraph; notifications set near-black text and
// white cards), which is unreadable on a dark pane. Such messages are shown on a light
// "paper" surface instead; mail that leaves colours to the reader follows the dark theme.

export type FrameTheme = 'light' | 'dark' | 'paper';

const COLOUR = /(?:^|[\s;{])(?:color|background(?:-color)?)\s*:/i;

/** True when the body sets a text or background colour of its own. Only markup is
 *  inspected (style attributes, <style> blocks, <font color>, bgcolor), not the text. */
export function setsOwnColours(html: string): boolean {
  if (/<font\b[^>]*\scolor\s*=|<[a-z][^>]*\sbgcolor\s*=/i.test(html)) return true;
  for (const m of html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (COLOUR.test((m[1] ?? m[2]).replace(/&quot;/g, '"'))) return true;
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    if (COLOUR.test(m[1])) return true;
  }
  return false;
}

export function frameTheme(html: string, dark: boolean): FrameTheme {
  if (!dark) return 'light';
  return setsOwnColours(html) ? 'paper' : 'dark';
}
