import { useState } from 'react';
import { Archive, ChevronDown, FilePen, Folder as FolderIcon, Inbox, Mail, Send, ShieldAlert, Trash2, type LucideIcon } from 'lucide-react';
import type { Folder, FolderRole, ViewScope } from '../api/types';
import { Menu, type Anchor, type MenuItem } from './ui';

/** The row of folder icons above the message list, in this order. Unread is Inbox filtered to unread. */
const ROLE_ITEMS: { key: FolderRole | 'unread'; label: string; Icon: LucideIcon }[] = [
  { key: 'inbox', label: 'Inbox', Icon: Inbox },
  { key: 'unread', label: 'Unread', Icon: Mail },
  { key: 'drafts', label: 'Drafts', Icon: FilePen },
  { key: 'sent', label: 'Sent', Icon: Send },
  { key: 'archive', label: 'Archive', Icon: Archive },
  { key: 'deleted', label: 'Deleted', Icon: Trash2 },
  { key: 'junk', label: 'Junk', Icon: ShieldAlert },
];

const ALWAYS: (FolderRole | 'unread')[] = ['inbox', 'unread'];

/** The folder tree below the system folders, depth first, sorted by name. */
export function userFolderTree(folders: Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parentId: string | undefined, depth: number) => {
    const children = folders.filter((f) => f.role === null && (f.parentId ?? undefined) === parentId).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of children) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

/** Name of what the list shows: a folder, or Unread. */
export function scopeTitle(scope: ViewScope, folders: Folder[]): string {
  if ('role' in scope.folder) {
    if (scope.folder.role === 'inbox' && scope.tab === 'unread') return 'Unread';
    const role = scope.folder.role;
    return ROLE_ITEMS.find((r) => r.key === role)?.label ?? 'Folder';
  }
  const id = scope.folder.id;
  return folders.find((f) => f.id === id)?.name ?? 'Folder';
}

export function FolderBar({ scope, folders, onChange }: { scope: ViewScope; folders: Folder[]; onChange: (s: ViewScope) => void }) {
  const [menu, setMenu] = useState<Anchor | null>(null);
  const role = 'role' in scope.folder ? scope.folder.role : null;
  const byRole = (r: FolderRole) => folders.find((f) => f.role === r);
  const tree = userFolderTree(folders);
  const inUserFolder = !('role' in scope.folder);

  const go = (folder: ViewScope['folder'], tab: ViewScope['tab'] = 'all') => onChange({ accountId: scope.accountId, folder, tab });

  const items = ROLE_ITEMS.filter((it) => ALWAYS.includes(it.key) || byRole(it.key as FolderRole));

  const menuItems: MenuItem[] = tree.map(({ folder: f, depth }) => ({
    label: f.name,
    sub: f.unread > 0 ? String(f.unread) : undefined,
    checked: inUserFolder && 'id' in scope.folder && scope.folder.id === f.id,
    icon: (
      <>
        {depth > 0 && <span style={{ width: depth * 14, flexShrink: 0 }} />}
        <FolderIcon size={14} />
      </>
    ),
    onSelect: () => go({ id: f.id }),
  }));

  return (
    <div className="folder-bar" role="tablist" aria-label="Folders">
      {items.map(({ key, label, Icon }) => {
        const selected = key === 'unread' ? role === 'inbox' && scope.tab === 'unread' : role === key && (key !== 'inbox' || scope.tab !== 'unread');
        const f = key === 'unread' ? undefined : byRole(key);
        const count = key === 'inbox' ? (f?.unread ?? 0) : key === 'drafts' ? (f?.total ?? 0) : 0;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={count ? `${label}, ${count}` : label}
            title={label}
            className={`folder-tab${selected ? ' selected' : ''}`}
            onClick={() => (key === 'unread' ? go({ role: 'inbox' }, 'unread') : go({ role: key }))}
          >
            <Icon size={17} />
            {count > 0 && <span className="folder-count">{count > 99 ? '99+' : count}</span>}
          </button>
        );
      })}
      {tree.length > 0 && (
        <button
          type="button"
          role="tab"
          aria-selected={inUserFolder}
          aria-haspopup="menu"
          aria-label="More folders"
          title="More folders"
          className={`folder-tab folder-more${inUserFolder ? ' selected' : ''}`}
          onClick={(e) => setMenu(e.currentTarget)}
        >
          <FolderIcon size={17} />
          <ChevronDown size={12} />
        </button>
      )}
      {menu && <Menu anchor={menu} items={menuItems} onClose={() => setMenu(null)} align="end" />}
    </div>
  );
}
