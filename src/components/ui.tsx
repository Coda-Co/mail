import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useCommand } from '../lib/commands';

// ---------- Popover anchored to an element or a point ----------

export type Anchor = { x: number; y: number } | HTMLElement | null;

export function Popover({ anchor, onClose, children, width, align = 'start' }: { anchor: Anchor; onClose: () => void; children: ReactNode; width?: number; align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    let left: number;
    let top: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      left = align === 'end' ? r.right - box.width : r.left;
      top = r.bottom + 6;
      if (top + box.height > window.innerHeight - 8) top = Math.max(8, r.top - box.height - 6);
    } else {
      left = anchor.x;
      top = anchor.y;
      if (top + box.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - box.height - 8);
    }
    left = Math.min(Math.max(8, left), window.innerWidth - box.width - 8);
    setPos({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) onClose();
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  useCommand('escape', () => {
    onClose();
  });

  if (!anchor) return null;
  return createPortal(
    <div ref={ref} className="popover" role="dialog" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width }}>
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  checked?: boolean;
  sub?: string;
  danger?: boolean;
  icon?: ReactNode;
  separatorBefore?: boolean;
}

export function Menu({ anchor, items, onClose, align }: { anchor: Anchor; items: MenuItem[]; onClose: () => void; align?: 'start' | 'end' }) {
  return (
    <Popover anchor={anchor} onClose={onClose} align={align}>
      <div role="menu">
        {items.map((it, i) => (
          <div key={i}>
            {it.separatorBefore && <div className="menu-sep" />}
            <button
              type="button"
              role="menuitem"
              className={`menu-item${it.checked ? ' checked' : ''}${it.danger ? ' btn-danger' : ''}`}
              onClick={() => {
                onClose();
                it.onSelect();
              }}
            >
              {it.icon}
              <span>{it.label}</span>
              {it.sub && <span className="sub">{it.sub}</span>}
            </button>
          </div>
        ))}
      </div>
    </Popover>
  );
}

// ---------- Modal ----------

export function Modal({ title, onClose, children, footer, wide, className }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string }) {
  useCommand('escape', () => {
    onClose();
  });
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Toasts ----------

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const ToastCtx = createContext<(text: string, action?: Toast['action']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {createPortal(
        <div className="toast-stack" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <span>{t.text}</span>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action!.run();
                    setToasts((all) => all.filter((x) => x.id !== t.id));
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------- Small pieces ----------

export function Avatar({ name, small, me }: { name: string; small?: boolean; me?: boolean }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const text = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 2);
  return <div className={`avatar${small ? ' small' : ''}${me ? ' me' : ''}`}>{text.toUpperCase()}</div>;
}

export function AccountDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className="acc-dot" style={{ background: color, width: size, height: size, borderRadius: size > 10 ? 3 : 2 }} />;
}
