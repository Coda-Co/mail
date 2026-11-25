import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameTheme, setsOwnColours } from './messageTheme';

const fixture = (name: string) => readFileSync(join(process.cwd(), 'fixtures/mail', name), 'utf8');

describe('frameTheme', () => {
  it('light mode always renders as sent', () => {
    expect(frameTheme(fixture('owa-reply.html'), false)).toBe('light');
    expect(frameTheme('<p>Hi</p>', false)).toBe('light');
  });

  it.each(['owa-reply.html', 'outlook-desktop-reply.html', 'gmail-reply.html', 'transactional-preheader.html', 'nowrap-signature.html'])(
    '%s pins its own colours, so dark mode shows it on paper',
    (name) => expect(frameTheme(fixture(name), true)).toBe('paper'),
  );

  it('mail without colours of its own follows the dark theme', () => {
    expect(frameTheme('<p>Hi Sam,</p><p>Sounds good.</p><blockquote>On Monday, Pat wrote:<br>Lunch?</blockquote>', true)).toBe('dark');
    expect(frameTheme('<p style="margin:0;font-family:Aptos;border-color:#ccc">Hi</p><style>p{margin:0}</style>', true)).toBe('dark');
  });

  it('only markup counts, not the words in the message', () => {
    expect(setsOwnColours('<p>Favourite color: blue. Background: none.</p>')).toBe(false);
    expect(setsOwnColours('<font color="#1F497D">Hi</font>')).toBe(true);
    expect(setsOwnColours('<td bgcolor="#ffffff">x</td>')).toBe(true);
    expect(setsOwnColours('<div style="background:#fff">x</div>')).toBe(true);
    expect(setsOwnColours('<div style="font-family:&quot;Segoe UI&quot;;color:#333">x</div>')).toBe(true);
    expect(setsOwnColours('<style>.x{background-color:#eee}</style>')).toBe(true);
  });
});
