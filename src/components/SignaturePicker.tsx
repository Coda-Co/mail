import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Signature } from '../api/types';
import { Menu } from './ui';

/** Pick the draft's signature: add one the draft was created without, swap it, or remove it. */
export function SignaturePicker({
  accountId,
  signatureId,
  onChange,
  onManage,
}: {
  accountId: string;
  signatureId?: string;
  onChange: (id: string | null) => void;
  /** Open the signature settings, to create or edit signatures. */
  onManage: () => void;
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

  const current = signatures.find((s) => s.id === signatureId);
  const pick = (id: string | null) => {
    if (id !== (signatureId ?? null)) onChange(id);
  };

  return (
    <>
      <button
        type="button"
        className="account-picker signature-picker"
        aria-label={`Signature: ${current ? current.name : signatureId ? 'custom' : 'none'}`}
        title="Change signature"
        onClick={(e) => {
          setAnchor(e.currentTarget);
          void load();
        }}
      >
        {signatures.length === 0 && !signatureId ? (
          'Add signature'
        ) : (
          <>
            {/* Labelled like From, so the name reads as the signature rather than a second account. */}
            <span className="signature-picker-label">Signature</span>
            {current ? current.name : signatureId ? 'Custom' : 'None'}
          </>
        )}{' '}
        ▾
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          onClose={() => setAnchor(null)}
          items={[
            { label: 'No signature', checked: !signatureId, onSelect: () => pick(null) },
            ...signatures.map((s) => ({ label: s.name, checked: s.id === signatureId, onSelect: () => pick(s.id) })),
            { label: signatures.length === 0 ? 'Create a signature…' : 'Manage signatures…', separatorBefore: true, onSelect: onManage },
          ]}
        />
      )}
    </>
  );
}
