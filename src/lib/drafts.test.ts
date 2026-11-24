import { describe, expect, it } from 'vitest';
import { hasNoContent } from './drafts';

const sig = '<div>Miles Rowland</div><div>Director</div>';
const blank = { to: [], cc: [], bcc: [], subject: '', attachments: [], bodyHtml: '<div><br></div>' };
const withSig = (before: string) => `${before}<div data-signature="s1"><p><br></p>${sig}</div>`;

describe('hasNoContent', () => {
  it('treats an empty body, or one with only the signature, as empty', () => {
    expect(hasNoContent(blank)).toBe(true);
    expect(hasNoContent({ ...blank, bodyHtml: withSig('<div><br></div>') }, sig)).toBe(true);
  });

  it('counts typed text, including text typed into the signature', () => {
    expect(hasNoContent({ ...blank, bodyHtml: withSig('<div>Hi</div>') }, sig)).toBe(false);
    expect(hasNoContent({ ...blank, bodyHtml: withSig('<div><br></div>').replace('Director', 'Director, thanks') }, sig)).toBe(false);
    expect(hasNoContent({ ...blank, bodyHtml: withSig('') }, undefined)).toBe(false);
  });

  it('counts recipients, subject, attachments and pasted images', () => {
    expect(hasNoContent({ ...blank, to: [{ name: '', email: 'a@b.example' }] })).toBe(false);
    expect(hasNoContent({ ...blank, subject: ' Lunch ' })).toBe(false);
    expect(hasNoContent({ ...blank, attachments: [{ id: 'a', name: 'x.pdf', contentType: 'application/pdf', size: 1, isInline: false }] })).toBe(false);
    expect(hasNoContent({ ...blank, bodyHtml: '<p><img src="data:image/png;base64,AA"></p>' })).toBe(false);
  });
});
