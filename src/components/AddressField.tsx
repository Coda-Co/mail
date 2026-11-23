import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import type { Address, Person } from '../api/types';
import { Popover } from './ui';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Parse "Name <a@b.c>", "a@b.c" or a list separated by , or ; */
export function parseAddresses(text: string): Address[] {
  return text
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
      if (m) return { name: m[1].trim(), email: m[2].trim() };
      return { name: '', email: s };
    });
}

export function AddressField({ value, onChange, label, autoFocus }: { value: Address[]; onChange: (v: Address[]) => void; label: string; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Person[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.listPeople(q, 6).then((p) => {
        if (!cancelled) {
          setSuggestions(p.filter((x) => !value.some((v) => v.email.toLowerCase() === x.email.toLowerCase())));
          setActive(0);
        }
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text, value]);

  const add = (addrs: Address[]) => {
    const fresh = addrs.filter((a) => !value.some((v) => v.email.toLowerCase() === a.email.toLowerCase()));
    if (fresh.length) onChange([...value, ...fresh]);
    setText('');
    setSuggestions([]);
  };

  const commit = () => {
    if (text.trim()) add(parseAddresses(text));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      e.stopPropagation();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault();
        const p = suggestions[active];
        add([{ name: p.name, email: p.email }]);
        return;
      }
      if (text.trim()) {
        e.preventDefault();
        commit();
      }
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
    if (e.key === 'Escape' && suggestions.length) {
      e.stopPropagation();
      setSuggestions([]);
    }
  };

  return (
    <div className="address-field" ref={wrapRef} onClick={() => inputRef.current?.focus()}>
      {value.map((a) => (
        <span key={a.email} className={`address-chip${EMAIL.test(a.email) ? '' : ' invalid'}`} title={a.email}>
          {a.name || a.email}
          <button
            type="button"
            aria-label={`Remove ${a.name || a.email}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((v) => v !== a));
            }}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="plain"
        aria-label={label}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => setTimeout(commit, 150)}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (/[,;]/.test(t) || EMAIL.test(t.trim())) {
            e.preventDefault();
            add(parseAddresses(t));
          }
        }}
      />
      {suggestions.length > 0 && (
        <Popover anchor={wrapRef.current} onClose={() => setSuggestions([])}>
          {suggestions.map((p, i) => (
            <button
              key={p.email}
              type="button"
              className={`menu-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add([{ name: p.name, email: p.email }])}
            >
              <span>{p.name}</span>
              <span className="sub">{p.email}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}
