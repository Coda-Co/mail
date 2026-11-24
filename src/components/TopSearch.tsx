import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { useCommand } from '../lib/commands';
import { keyLabel } from '../lib/platform';
import { useSearchSlot } from './TopBar';
import { Menu, type Anchor } from './ui';

/** An optional picker at the left of the box for what the text is matched against. */
export interface FieldPicker<F extends string> {
  labels: Record<F, string>;
  value: F;
  onChange: (f: F) => void;
}

/**
 * The top bar's search box for views that filter as you type (People,
 * Calendar). It lives in the top bar's search slot while the view is shown.
 * Ctrl/Cmd+E focuses it; Escape clears it (and any filters, via onClear).
 */
export function TopSearch<F extends string>({
  value,
  onChange,
  placeholder,
  field,
  active = !!value,
  onClear = () => onChange(''),
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  field?: FieldPicker<F>;
  /** Whether there's anything to clear; defaults to having text. */
  active?: boolean;
  onClear?: () => void;
}) {
  const slot = useSearchSlot();
  const input = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);

  useCommand('search', () => {
    input.current?.focus();
    input.current?.select();
  });
  useCommand('escape', () => {
    if (!active && document.activeElement !== input.current) return false;
    onClear();
    input.current?.blur();
  });

  if (!slot) return null;
  return createPortal(
    <div className="search-box quiet">
      <Search size={15} />
      {field && (
        <button type="button" className="scope-chip field-chip" aria-haspopup="menu" aria-label={`Search in: ${field.labels[field.value]}`} onClick={(e) => setMenu(menu ? null : e.currentTarget)}>
          {field.labels[field.value]} ▾
        </button>
      )}
      <input ref={input} aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {active ? (
        <button
          type="button"
          className="clear-search"
          aria-label="Clear search"
          onClick={() => {
            onClear();
            input.current?.focus();
          }}
        >
          <X size={15} />
        </button>
      ) : (
        <span className="kbd-hint">{keyLabel('Mod+E')}</span>
      )}
      {field && menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={(Object.keys(field.labels) as F[]).map((f) => ({
            label: field.labels[f],
            checked: field.value === f,
            onSelect: () => {
              field.onChange(f);
              setTimeout(() => input.current?.focus(), 0);
            },
          }))}
        />
      )}
    </div>,
    slot,
  );
}
