import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Signature } from '../api/types';
import { Menu } from './ui';

/** Pick the draft's signature: add one the draft was created without, swap it, or remove it. */
export function SignaturePicker({
  accountId,
  signatureId,
  onChange,
}: {
  accountId: string;
  signatureId?: string;
  onChange: (id: string | null) => void;
}) {
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const load = () =>
    api
      .listSignatures(accountId)
      .then(setSignatures)
      .catch(() => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // Nothing to pick from: the account has no signatures and the draft carries none.
  if (signatures.length === 0 && !signatureId) return null;
  const current = signatures.find((s) => s.id === signatureId);
  const pick = (id: string | null) => {
    if (id !== (signatureId ?? null)) onChange(id);
  };

  return (
    <>
      <button
        type="button"
        className="account-picker signature-picker"
        aria-label="Signature"
        title="Signature"
        onClick={(e) => {
          setAnchor(e.currentTarget);
          void load();
        }}
      >
        {current ? current.name : signatureId ? 'Signature' : 'No signature'} ▾
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          onClose={() => setAnchor(null)}
          items={[
            { label: 'No signature', checked: !signatureId, onSelect: () => pick(null) },
            ...signatures.map((s) => ({ label: s.name, checked: s.id === signatureId, onSelect: () => pick(s.id) })),
          ]}
        />
      )}
    </>
  );
}
