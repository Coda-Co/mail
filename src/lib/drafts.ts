import type { Draft } from '../api/types';
import { htmlToText } from './text';

const squash = (html: string) => htmlToText(html).replace(/\s+/g, ' ').trim();
const images = (html: string) => (html.match(/<img\b/gi) ?? []).length;

/**
 * True when a draft holds nothing worth keeping: no recipients, subject or
 * attachments, and a body that is empty or just the untouched signature.
 * Pass the signature's HTML when the draft has one.
 */
export function hasNoContent(d: Pick<Draft, 'to' | 'cc' | 'bcc' | 'subject' | 'attachments' | 'bodyHtml'>, signatureHtml?: string): boolean {
  if (d.to.length || d.cc.length || d.bcc.length || d.attachments.length || d.subject.trim()) return false;
  if (images(d.bodyHtml) > images(signatureHtml ?? '')) return false;
  const text = squash(d.bodyHtml);
  return text === '' || (signatureHtml !== undefined && text === squash(signatureHtml));
}
