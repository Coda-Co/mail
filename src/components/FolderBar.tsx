import { useState } from 'react';
import { Archive, ChevronDown, ClockArrowUp, FilePen, Folder as FolderIcon, Inbox, Mail, Send, ShieldAlert, Trash2, type LucideIcon } from 'lucide-react';
import type { Folder, FolderRole, ViewScope } from '../api/types';
import { Menu, type Anchor, type MenuItem } from './ui';

type ItemKey = FolderRole | 'unread' | 'outbox';

/**
 * The row of folder icons above the message list, in this order. Unread is Inbox filtered to
 * unread; Outbox is the drafts sent but not yet gone (it lives in Drafts, so it shows wherever
 * Drafts does).
 */
const ROLE_ITEMS: { key: ItemKey; label: string; Icon: LucideIcon }[] = [
  { key: 'inbox', label: 'Inbox', Icon: Inbox },
  { key: 'unread', label: 'Unread', Icon: Mail },
  { key: 'drafts', label: 'Drafts', Icon: FilePen },
  { key: 'outbox', label: 'Outbox', Icon: ClockArrowUp },
  { key: 'sent', label: 'Sent', Icon: Send },
  { key: 'archive', label: 'Archive', Icon: Archive },
  { key: 'deleted', label: 'Deleted', Icon: Trash2 },
  { key: 'junk', label: 'Junk', Icon: ShieldAlert },
];

const ALWAYS: ItemKey[] = ['inbox', 'unread'];

/** The tab an item opens: Unread and Outbox are filters over Inbox and Drafts. */
const TARGET: Partial<Record<ItemKey, { role: FolderRole; tab: ViewScope['tab'] }>> = {
  unread: { role: 'inbox', tab: 'unread' },
  outbox: { role: 'drafts', tab: 'outbox' },
};

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
    if (scope.folder.role === 'drafts' && scope.tab === 'outbox') return 'Outbox';
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

  const outboxCount = byRole('drafts')?.outbox ?? 0;
  const items = ROLE_ITEMS.filter((it) => ALWAYS.includes(it.key) || byRole((it.key === 'outbox' ? 'drafts' : it.key) as FolderRole));

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
        const target = TARGET[key];
        const selected = target ? role === target.role && scope.tab === target.tab : role === key && !(key === 'inbox' && scope.tab === 'unread') && !(key === 'drafts' && scope.tab === 'outbox');
        const f = target ? undefined : byRole(key as FolderRole);
        // Drafts: the drafts still being written (the app's own count, not the server's).
        const count = key === 'inbox' || key === 'drafts' ? (f?.unread ?? 0) : key === 'outbox' ? outboxCount : 0;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={count ? `${label}, ${count}` : label}
            title={label}
            className={`folder-tab${selected ? ' selected' : ''}`}
            onClick={() => (target ? go({ role: target.role }, target.tab) : go({ role: key as FolderRole }))}
          >
            <Icon size={17} />
            {count > 0 && <span className={`folder-count${key === 'inbox' ? ' unread' : ''}`}>{count > 99 ? '99+' : count}</span>}
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
