import { useState } from 'react';
import { useApp } from '../state/app';
import { Menu } from './ui';

export function AccountPicker({ accountId, onChange }: { accountId: string; onChange: (id: string) => void }) {
  const { graphAccounts, accountById } = useApp();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const acc = accountById(accountId);
  return (
    <>
      <button type="button" className="account-picker" aria-label="From account" onClick={(e) => setAnchor(e.currentTarget)}>
        <span className="acc-dot" style={{ background: acc?.color }} />
        {acc?.displayName ?? 'Choose account'} ▾
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          onClose={() => setAnchor(null)}
          items={graphAccounts.map((a) => ({
            label: a.displayName,
            sub: a.email,
            checked: a.id === accountId,
            icon: <span className="acc-dot" style={{ background: a.color }} />,
            onSelect: () => a.id !== accountId && onChange(a.id),
          }))}
        />
      )}
    </>
  );
}
