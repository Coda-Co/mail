import {
  Calendar,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Mail,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import { fileKind, type FileKind } from '../lib/fileTypes';

const ICONS: Record<FileKind, LucideIcon> = {
  pdf: FileType2,
  slides: Presentation,
  sheet: FileSpreadsheet,
  doc: FileText,
  image: FileImage,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  email: Mail,
  calendar: Calendar,
  code: FileCode,
  text: FileText,
  other: File,
};

/** File-type icon, coloured by kind (PDF red, slides orange, sheets green, documents blue). */
export function FileIcon({ name, contentType, size = 16 }: { name: string; contentType?: string; size?: number }) {
  const kind = fileKind(name, contentType);
  const Icon = ICONS[kind];
  return <Icon size={size} className={`file-icon file-${kind}`} aria-hidden="true" />;
}
