// Needs a DOM: add `jsdom` as a dev dependency and set this file's vitest environment to
// jsdom (a vitest-environment comment at the top). Until then these tests are skipped.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitQuoted } from './quoted';

// Bodies in fixtures/mail/ copy the markup real clients send (content is synthetic).
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/mail/${name}`, import.meta.url), 'utf8');

function text(html: string): string {
  return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Empty lines (no text, no image) left at the very end of the new part. */
function trailingBlankLines(html: string): number {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  let n = 0;
  for (let el = body.lastElementChild; el; el = el.previousElementSibling) {
    // Descend into a wrapper that holds the whole message (Outlook's WordSection1).
    if (el === body.lastElementChild && el.children.length > 1 && /WordSection/.test(el.className)) el = el.lastElementChild!;
    if ((el.textContent ?? '').replace(/[\s ]/g, '') || el.querySelector('img')) break;
    n++;
  }
  return n;
}

describe.skipIf(typeof DOMParser === 'undefined')('splitQuoted on real-world markup', () => {
  it('Outlook desktop: cuts at the first border-top header, keeps signature and styles', () => {
    const { main, hasQuote } = splitQuoted(fixture('outlook-desktop-reply.html'));
    expect(hasQuote).toBe(true);
    const t = text(main);
    expect(t).toContain('can you send the JSON example as text please?');
    expect(t).toContain('Telephone calls may be monitored');
    expect(t).not.toContain('From:');
    expect(t).not.toContain('Caution:');
    expect(t).not.toContain('here’s a version');
    expect(main).toContain('p.MsoNormal');
  });

  it('Outlook on the web: cuts at the inline-block <hr> and the header after it', () => {
    const { main, hasQuote } = splitQuoted(fixture('owa-reply.html'));
    expect(hasQuote).toBe(true);
    const t = text(main);
    expect(t).toMatch(/Thanks,\s*Jordan$/);
    expect(t).toContain('we can map town to region');
    expect(main).not.toContain('<hr');
    expect(t).not.toContain('Instance name');
  });

  // OWA puts `#appendonsend`, `<div><br></div>` and a 12pt `<div><br></div>` between the
  // signature and the separator, so the collapsed view ends in empty lines above the toggle.
  it.fails('Outlook on the web: leaves no blank lines above the quote toggle', () => {
    const { main } = splitQuoted(fixture('owa-reply.html'));
    expect(trailingBlankLines(main)).toBe(0);
  });

  // The separator is wrapped: `<div align=center><hr></div><div id=divRplyFwdMsg>`. Only a
  // bare <hr> sibling is taken with the header, so a stray rule is left under the reply.
  it.fails('Outlook mobile: takes the centred <div><hr></div> separator with the header', () => {
    const { main, hasQuote } = splitQuoted(fixture('outlook-centered-hr-reply.html'));
    expect(hasQuote).toBe(true);
    expect(text(main)).toBe('Apologies, I missed the attachment from my last email. Please find it attached here.');
    expect(main).not.toContain('<hr');
  });

  it('Outlook mobile: still finds the divRplyFwdMsg header', () => {
    const { main, hasQuote } = splitQuoted(fixture('outlook-centered-hr-reply.html'));
    expect(hasQuote).toBe(true);
    expect(text(main)).not.toContain('From:');
    expect(text(main)).not.toContain('v1.2');
  });

  it('Gmail: cuts at gmail_quote, keeps the signature, hides the disclaimer appended after the quote', () => {
    const { main, hasQuote } = splitQuoted(fixture('gmail-reply.html'));
    expect(hasQuote).toBe(true);
    const t = text(main);
    expect(t).toContain('Please also add me to this');
    expect(t).toContain('Morgan Founder');
    expect(t).not.toContain('wrote:');
    expect(t).not.toContain('readout session');
    expect(t).not.toContain('GDPR');
  });

  // A short note on top of a forward collapses the forwarded message behind the toggle.
  // Recorded as current behaviour: worth deciding whether forwards should stay expanded.
  it('Outlook desktop forward: the forwarded message is treated as quoted history', () => {
    const { main, hasQuote } = splitQuoted(fixture('outlook-desktop-forward.html'));
    expect(hasQuote).toBe(true);
    expect(text(main)).toContain('Is there anyone on your team');
    expect(text(main)).not.toContain('As discussed');
  });

  it.each(['transactional-preheader.html', 'nowrap-signature.html'])('%s: no quote, body untouched', (name) => {
    const html = fixture(name);
    const { main, hasQuote } = splitQuoted(html);
    expect(hasQuote).toBe(false);
    expect(main).toBe(html);
  });
});
