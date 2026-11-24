import { describe, expect, it } from 'vitest';
import { fileKind } from './fileTypes';

describe('fileKind', () => {
  it('uses the extension, case-insensitively', () => {
    expect(fileKind('Steerco - 18_11_v2.pptx')).toBe('slides');
    expect(fileKind('Steerco - 18_11_v2.PDF')).toBe('pdf');
    expect(fileKind('Budget.xlsx')).toBe('sheet');
    expect(fileKind('Contract v3.docx')).toBe('doc');
    expect(fileKind('photo.HEIC')).toBe('image');
  });
  it('falls back to the MIME type', () => {
    expect(fileKind('Forwarded message', 'message/rfc822')).toBe('email');
    expect(fileKind('deck', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('slides');
    expect(fileKind('.hidden', 'image/png')).toBe('image');
  });
  it('is "other" when nothing matches', () => {
    expect(fileKind('README')).toBe('other');
    expect(fileKind('data.bin', 'application/octet-stream')).toBe('other');
  });
});
