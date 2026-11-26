// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isBlankHtml, stripMeetingBlock } from './meetingBody';

const RULE = '<div style="width:100%"><span style="white-space:nowrap;color:#5F5F5F;opacity:.36">________________________________________________________________________________</span></div>';
const TEAMS = `${RULE}<div class="me-email-text"><div style="margin-bottom:24px"><span style="font-size:24px;font-weight:700">Microsoft Teams meeting</span></div><div><span>Join: </span><a href="https://teams.microsoft.com/meet/347497567667899?p=rdBnCmNugvFQFhxj00">https://teams.microsoft.com/meet/347497567667899?p=rdBnCmNugvFQFhxj00</a></div><div>Meeting ID: 347 497 567 667 899</div></div>${RULE}`;

describe('stripMeetingBlock', () => {
  it('removes the Teams block and keeps the agenda', () => {
    const out = stripMeetingBlock(`<p>Agenda: walk through the scan.</p>${TEAMS}<p>Thanks</p>`);
    expect(out).toContain('Agenda: walk through the scan.');
    expect(out).toContain('Thanks');
    expect(out).not.toContain('teams.microsoft.com');
    expect(out).not.toContain('____');
  });

  it('leaves nothing when the block is all there is', () => {
    expect(isBlankHtml(stripMeetingBlock(TEAMS))).toBe(true);
  });

  it('keeps rule lines that are not around a meeting link', () => {
    const html = `<p>Notes</p>${RULE}<p>Signature</p>`;
    expect(stripMeetingBlock(html)).toBe(html);
  });

  it('cuts to the end when there is a single rule before a link', () => {
    const out = stripMeetingBlock(`<p>Hi</p>${RULE}<p>Join Zoom: <a href="https://acme.zoom.us/j/1">link</a></p>`);
    expect(out).toContain('Hi');
    expect(out).not.toContain('zoom');
  });
});
