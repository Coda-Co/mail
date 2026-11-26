// Event descriptions: the online-meeting block Teams adds to every invitation, which the
// event panel already covers with its join button.

const RULE = /^\s*_{10,}\s*$/;
const MEETING_HOST = /\bteams\.|zoom\.us|meet\.google\.com|webex\.com/i;

/** The outermost element around node that holds nothing but node's text. */
function wrapper(node: Node, body: HTMLElement): Node {
  let n: Node = node;
  const text = (node.textContent ?? '').trim();
  while (n.parentNode && n.parentNode !== body && (n.parentNode.textContent ?? '').trim() === text) n = n.parentNode;
  return n;
}

/**
 * The description without the "________ Microsoft Teams meeting · Join: https://… ________"
 * block (from the first rule line to the last, when it holds a meeting link). Unchanged when
 * there's no such block or no DOM to parse with.
 */
export function stripMeetingBlock(html: string): string {
  if (!html || typeof DOMParser === 'undefined' || !html.includes('_____')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  const rules: Node[] = [];
  const walk = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (RULE.test(n.textContent ?? '')) rules.push(n);
  if (rules.length === 0) return html;
  const range = doc.createRange();
  range.setStartBefore(wrapper(rules[0], body));
  if (rules.length > 1) range.setEndAfter(wrapper(rules[rules.length - 1], body));
  else range.setEndAfter(body.lastChild!);
  const cut = range.cloneContents();
  const links = Array.from(cut.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
  if (!MEETING_HOST.test(range.toString()) && !links.some((h) => MEETING_HOST.test(h))) return html;
  range.deleteContents();
  return body.innerHTML;
}

/** True when the description has nothing to show (whitespace, empty paragraphs). */
export function isBlankHtml(html: string): boolean {
  if (!html.trim()) return true;
  if (/<img\b/i.test(html)) return false;
  return !html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '');
}
