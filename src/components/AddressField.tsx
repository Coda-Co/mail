import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import type { Address, Person } from '../api/types';
import { EMAIL, formatAddresses, looksLikeAddresses, mergeAddresses, parseAddresses, removeAddresses } from '../lib/addresses';
import { isMac } from '../lib/platform';
import { Popover, useToast } from './ui';

export { parseAddresses };

/** Drag type for chips, so only recipient drags light up the fields as drop targets. */
const DRAG_TYPE = 'application/x-mail-recipients';

/**
 * The chip drag in progress, if it started in this window. The target removes the chips from
 * the field they came from: dragend's dropEffect is not reliable in every web view.
 */
let activeDrag: { field: symbol; addrs: Address[]; remove: () => void } | null = null;

const key = (a: Address) => a.email.toLowerCase();

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older web views without the async clipboard.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('copy failed');
  }
}

export function AddressField({ value, onChange, label, autoFocus }: { value: Address[]; onChange: (v: Address[]) => void; label: string; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Person[]>([]);
  const [active, setActive] = useState(0);
  // Selected chips, by lower-cased email; anchor is where a Shift range starts.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const dragDepth = useRef(0);
  const fieldId = useRef(Symbol(label));
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<string, HTMLSpanElement>());
  // Latest value for the drag source's remove callback, which outlives this render.
  const valueRef = useRef(value);
  valueRef.current = value;
  const toast = useToast();

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
          setSuggestions(p.filter((x) => !value.some((v) => key(v) === key(x))));
          setActive(0);
        }
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text, value]);

  // Drop selections whose chips have gone (removed, cut or dragged away).
  useEffect(() => {
    setSelected((s) => {
      const live = new Set(value.map(key));
      const next = new Set([...s].filter((k) => live.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [value]);

  const add = (addrs: Address[]) => {
    const next = mergeAddresses(value, addrs);
    if (next !== value) onChange(next);
    setText('');
    setSuggestions([]);
  };

  const commit = () => {
    if (text.trim()) add(parseAddresses(text));
  };

  const selectedAddrs = () => value.filter((a) => selected.has(key(a)));

  const focusChip = (k: string) => chipRefs.current.get(k)?.focus();

  const select = (keys: string[], focus?: string) => {
    setSelected(new Set(keys));
    if (focus) focusChip(focus);
  };

  const removeSelected = (from: string) => {
    const idx = value.findIndex((a) => key(a) === from);
    const rest = value.filter((a) => !selected.has(key(a)));
    onChange(rest);
    setSelected(new Set());
    // Land on the chip that took the removed one's place, or the input.
    const after = value.slice(idx + 1).find((a) => !selected.has(key(a)));
    if (after) select([key(after)], key(after));
    else inputRef.current?.focus();
  };

  const copySelected = async (cut: boolean, from: string) => {
    const addrs = selectedAddrs();
    if (!addrs.length) return;
    try {
      await writeClipboard(formatAddresses(addrs));
    } catch {
      toast("Couldn't copy the addresses");
      return;
    }
    if (cut) removeSelected(from);
  };

  const onChipMouseDown = (e: MouseEvent, a: Address) => {
    // Keep focus moves ours; let the drag start as normal.
    e.stopPropagation();
    const k = key(a);
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.shiftKey && anchor.current) {
      const i = value.findIndex((v) => key(v) === anchor.current);
      const j = value.findIndex((v) => key(v) === k);
      const [lo, hi] = i < j ? [i, j] : [j, i];
      select(value.slice(lo, hi + 1).map(key), k);
      return;
    }
    if (mod) {
      const next = new Set(selected);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      anchor.current = k;
      setSelected(next);
      focusChip(k);
      return;
    }
    anchor.current = k;
    // Pressing on a chip that's already part of a selection keeps it, so all of them can be dragged.
    if (!selected.has(k)) select([k], k);
    else focusChip(k);
  };

  const onChipKey = (e: KeyboardEvent<HTMLSpanElement>, a: Address) => {
    const k = key(a);
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const lower = e.key.toLowerCase();
    const i = value.findIndex((v) => key(v) === k);
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && (lower === 'c' || lower === 'x') && !e.shiftKey && !e.altKey) {
      handled();
      void copySelected(lower === 'x', k);
    } else if (mod && lower === 'a') {
      handled();
      select(value.map(key), k);
    } else if (mod && lower === 'v') {
      // Paste goes to the input, which turns addresses into chips.
      e.stopPropagation();
      setSelected(new Set());
      inputRef.current?.focus();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      handled();
      removeSelected(k);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      handled();
      const j = i + (e.key === 'ArrowLeft' ? -1 : 1);
      if (j >= value.length) {
        setSelected(new Set());
        inputRef.current?.focus();
        return;
      }
      const to = value[Math.max(0, j)];
      if (e.shiftKey) {
        const next = new Set(selected);
        next.add(key(to));
        setSelected(next);
        focusChip(key(to));
      } else {
        anchor.current = key(to);
        select([key(to)], key(to));
      }
    } else if (e.key === 'Escape' || e.key === 'Enter') {
      handled();
      setSelected(new Set());
      inputRef.current?.focus();
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      // Typing goes on in the input, not to app shortcuts.
      e.stopPropagation();
      setSelected(new Set());
      inputRef.current?.focus();
    }
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
    // From an empty input, Left steps back into the chips.
    if (e.key === 'ArrowLeft' && !text && value.length) {
      e.preventDefault();
      const last = key(value[value.length - 1]);
      anchor.current = last;
      select([last], last);
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
    if (e.key === 'Escape' && suggestions.length) {
      e.stopPropagation();
      setSuggestions([]);
    }
  };

  // ---------- Dragging chips between To, Cc and Bcc ----------

  const onChipDragStart = (e: DragEvent, a: Address) => {
    const addrs = selected.has(key(a)) ? selectedAddrs() : [a];
    const text = formatAddresses(addrs);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(addrs));
    e.dataTransfer.setData('text/plain', text);
    e.dataTransfer.effectAllowed = 'copyMove';
    activeDrag = {
      field: fieldId.current,
      addrs,
      remove: () => onChange(removeAddresses(valueRef.current, addrs)),
    };
  };

  const onChipDragEnd = () => {
    activeDrag = null;
  };

  const isRecipientDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);
  // Alt (Mac) or Ctrl (Windows, Linux) copies instead of moving, as in file managers.
  const wantsCopy = (e: DragEvent) => (isMac ? e.altKey : e.ctrlKey);
  const fromHere = () => activeDrag?.field === fieldId.current;

  const onDragEnter = (e: DragEvent) => {
    if (!isRecipientDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!fromHere()) setDropTarget(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!isRecipientDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = fromHere() ? 'none' : wantsCopy(e) ? 'copy' : 'move';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!isRecipientDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropTarget(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!isRecipientDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDropTarget(false);
    if (fromHere()) return;
    let addrs: Address[] = [];
    try {
      addrs = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
    } catch {
      addrs = parseAddresses(e.dataTransfer.getData('text/plain'));
    }
    if (!addrs.length) return;
    add(addrs);
    // Chips from another window are copied: that draft is not ours to change.
    if (activeDrag && !wantsCopy(e)) activeDrag.remove();
    activeDrag = null;
    const keys = addrs.map(key);
    anchor.current = keys[0];
    setSelected(new Set(keys));
    // Focus once the chips have rendered.
    setTimeout(() => focusChip(keys[keys.length - 1]), 0);
  };

  return (
    <div
      className={`address-field${dropTarget ? ' drop-target' : ''}`}
      ref={wrapRef}
      onMouseDown={(e) => {
        // A press on the empty part of the field clears chip selection and goes to the input.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          setSelected(new Set());
          inputRef.current?.focus();
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSelected(new Set());
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {value.map((a) => {
        const k = key(a);
        const isSelected = selected.has(k);
        return (
          <span
            key={a.email}
            ref={(el) => {
              if (el) chipRefs.current.set(k, el);
              else chipRefs.current.delete(k);
            }}
            className={`address-chip${EMAIL.test(a.email) ? '' : ' invalid'}${isSelected ? ' selected' : ''}`}
            title={a.name ? `${a.name} <${a.email}>` : a.email}
            tabIndex={-1}
            role="option"
            aria-selected={isSelected}
            draggable
            onMouseDown={(e) => onChipMouseDown(e, a)}
            onKeyDown={(e) => onChipKey(e, a)}
            onDragStart={(e) => onChipDragStart(e, a)}
            onDragEnd={onChipDragEnd}
          >
            {a.name || a.email}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Remove ${a.name || a.email}`}
              draggable={false}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((v) => v !== a));
              }}
            >
              <X size={12} />
            </button>
          </span>
        );
      })}
      <input
        ref={inputRef}
        className="plain"
        aria-label={label}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onFocus={() => setSelected(new Set())}
        onBlur={() => setTimeout(commit, 150)}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (looksLikeAddresses(t)) {
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
