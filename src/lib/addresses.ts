import type { Address } from '../api/types';

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Split on , and ; that sit outside double quotes, so "Smith, Jo" <jo@x.com> stays whole. */
function splitList(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === ',' || ch === ';' || ch === '\n')) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Parse "Name <a@b.c>", "a@b.c" or a list of either separated by , ; or newlines. */
export function parseAddresses(text: string): Address[] {
  return splitList(text).map((s) => {
    const m = s.match(/^"?((?:[^"<]|\\")*?)"?\s*<([^>]+)>$/);
    if (m) return { name: m[1].replace(/\\"/g, '"').trim(), email: m[2].trim() };
    return { name: '', email: s };
  });
}

/** One address as it would appear in a header; round-trips through parseAddresses. */
export function formatAddress(a: Address): string {
  if (!a.name || a.name === a.email) return a.email;
  const name = /[",;<>@]/.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
  return `${name} <${a.email}>`;
}

export function formatAddresses(list: Address[]): string {
  return list.map(formatAddress).join(', ');
}

/** Whether pasted text is one or more addresses, rather than the start of a name to search for. */
export function looksLikeAddresses(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (EMAIL.test(t) || /<[^>]+@[^>]+>/.test(t)) return true;
  return /[,;\n]/.test(t) && parseAddresses(t).some((a) => EMAIL.test(a.email));
}

/** Add addresses not already in the list (by email, ignoring case). */
export function mergeAddresses(list: Address[], add: Address[]): Address[] {
  const seen = new Set(list.map((a) => a.email.toLowerCase()));
  const fresh = add.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return fresh.length ? [...list, ...fresh] : list;
}

/** The list without the given addresses (by email, ignoring case). */
export function removeAddresses(list: Address[], remove: Address[]): Address[] {
  const drop = new Set(remove.map((a) => a.email.toLowerCase()));
  return list.filter((a) => !drop.has(a.email.toLowerCase()));
}
