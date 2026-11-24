export type FileKind = 'pdf' | 'slides' | 'sheet' | 'doc' | 'image' | 'archive' | 'audio' | 'video' | 'email' | 'calendar' | 'code' | 'text' | 'other';

const BY_EXTENSION: Record<string, FileKind> = {
  pdf: 'pdf',
  ppt: 'slides', pptx: 'slides', pptm: 'slides', pps: 'slides', ppsx: 'slides', potx: 'slides', key: 'slides', odp: 'slides',
  xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', xlsb: 'sheet', xltx: 'sheet', csv: 'sheet', tsv: 'sheet', numbers: 'sheet', ods: 'sheet',
  doc: 'doc', docx: 'doc', docm: 'doc', dotx: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', webp: 'image', heic: 'image', heif: 'image', tif: 'image', tiff: 'image', svg: 'image',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', wmv: 'video',
  eml: 'email', msg: 'email',
  ics: 'calendar', vcs: 'calendar',
  json: 'code', xml: 'code', html: 'code', htm: 'code', js: 'code', ts: 'code', py: 'code', sql: 'code', yml: 'code', yaml: 'code',
  txt: 'text', md: 'text', log: 'text',
};

/** What kind of file this is, from its extension, falling back to the MIME type. */
export function fileKind(name: string, contentType = ''): FileKind {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  const ct = contentType.toLowerCase();
  if (ct === 'application/pdf') return 'pdf';
  if (ct.includes('presentation') || ct.includes('powerpoint')) return 'slides';
  if (ct.includes('spreadsheet') || ct.includes('excel')) return 'sheet';
  if (ct.includes('wordprocessing') || ct.includes('msword')) return 'doc';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  if (ct === 'message/rfc822') return 'email';
  if (ct === 'text/calendar') return 'calendar';
  if (ct.includes('zip') || ct.includes('compressed')) return 'archive';
  if (ct.startsWith('text/')) return 'text';
  return 'other';
}
