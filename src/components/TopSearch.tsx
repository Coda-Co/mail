import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { useCommand } from '../lib/commands';
import { keyLabel } from '../lib/platform';
import { useSearchSlot } from './TopBar';

/**
 * The top bar's search box for views that filter as you type (People,
 * Calendar). It lives in the top bar's search slot while the view is shown.
 * Ctrl/Cmd+E focuses it; Escape clears it.
 */
export function TopSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const slot = useSearchSlot();
  const input = useRef<HTMLInputElement>(null);

  useCommand('search', () => {
    input.current?.focus();
    input.current?.select();
  });
  useCommand('escape', () => {
    if (!value && document.activeElement !== input.current) return false;
    onChange('');
    input.current?.blur();
  });

  if (!slot) return null;
  return createPortal(
    <div className="search-box quiet">
      <Search size={15} />
      <input ref={input} aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {value ? (
        <button
          type="button"
          className="clear-search"
          aria-label="Clear search"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <X size={15} />
        </button>
      ) : (
        <span className="kbd-hint">{keyLabel('Mod+E')}</span>
      )}
    </div>,
    slot,
  );
}
