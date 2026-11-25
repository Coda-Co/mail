// Finds where a reply's quoted history starts ("On … wrote:", Gmail's quote block, an
// Outlook "From: … Subject:" header) so the reading pane can hide it behind a toggle.

const QUOTE_CLASSES = ['gmail_quote', 'gmail_quote_container', 'yahoo_quoted', 'moz-cite-prefix'];
const WROTE = /^\s*On\b[\s\S]{4,300}\bwrote:\s*$/;
const ORIGINAL = /^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i;

function isHeaderBlock(text: string): boolean {
  const t = text.trimStart();
  return /^From:\s/.test(t) && /Subject:/.test(t) && /(Sent|Date|To):/.test(t);
}

function isMarker(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent ?? '';
    return WROTE.test(t) || ORIGINAL.test(t);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (QUOTE_CLASSES.some((c) => el.classList.contains(c))) return true;
  const text = el.textContent ?? '';
  if (/^(DIV|P)$/.test(el.tagName) && isHeaderBlock(text)) return true;
  // "On … wrote:" as its own paragraph, followed by the quote.
  if (/^(DIV|P)$/.test(el.tagName) && WROTE.test(text)) return true;
  return false;
}

function hasContent(root: Element): boolean {
  return (root.textContent ?? '').replace(/ /g, ' ').trim().length > 0 || !!root.querySelector('img');
}

const INVISIBLE = /[\s ​-‍⁠﻿]/g;

/** No visible text and no image: an empty line, a spacer or a bare separator rule. */
function isBlank(n: Node): boolean {
  if (n.nodeType === Node.TEXT_NODE) return !(n.textContent ?? '').replace(INVISIBLE, '');
  if (n.nodeType !== Node.ELEMENT_NODE) return true;
  const el = n as Element;
  return !(el.textContent ?? '').replace(INVISIBLE, '') && el.tagName !== 'IMG' && !el.querySelector('img');
}

/** Drop the empty lines and separator left above the quote (Outlook on the web leaves
 *  `<div><br></div>`s, Outlook mobile wraps its rule in `<div align=center><hr></div>`). */
function trimTrailing(el: Node) {
  for (let last = el.lastChild; last; last = el.lastChild) {
    if (!isBlank(last)) {
      // Don't reach into tables: an empty last cell can be part of a signature's layout.
      if (last.nodeType === Node.ELEMENT_NODE && (last as Element).tagName !== 'TABLE') trimTrailing(last);
      return;
    }
    el.removeChild(last);
  }
}

export interface SplitBody {
  /** The new part of the message, without quoted history. */
  main: string;
  /** True when quoted history was found and removed from `main`. */
  hasQuote: boolean;
}

/** Splits a (sanitised) message body at the start of its quoted history. */
export function splitQuoted(html: string): SplitBody {
  if (typeof DOMParser === 'undefined') return { main: html, hasQuote: false };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!isMarker(n)) continue;
    // Take a separator line just before the header with it.
    let start: Node = n;
    let prev = start.previousSibling;
    while (prev && prev.nodeType === Node.TEXT_NODE && !(prev.textContent ?? '').trim()) prev = prev.previousSibling;
    if (prev && prev.nodeName === 'HR') start = prev;
    const trimmed = body.cloneNode(true) as HTMLElement;
    // Locate the same node in the clone by its path, then cut from there to the end.
    const path: number[] = [];
    for (let c: Node = start; c !== body; c = c.parentNode!) path.unshift(Array.prototype.indexOf.call(c.parentNode!.childNodes, c));
    let target: Node = trimmed;
    for (const i of path) target = target.childNodes[i];
    const range = doc.createRange();
    range.setStartBefore(target);
    range.setEndAfter(trimmed.lastChild!);
    range.deleteContents();
    // A message that is nothing but a forward keeps everything.
    if (!hasContent(trimmed)) return { main: html, hasQuote: false };
    trimTrailing(trimmed);
    // Keep the sender's <style> blocks, which sit in <head> after parsing.
    return { main: doc.head.innerHTML + trimmed.innerHTML, hasQuote: true };
  }
  return { main: html, hasQuote: false };
}
