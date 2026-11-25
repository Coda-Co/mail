import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, X } from 'lucide-react';
import { api } from '../api';
import type { DateFilter, Person, SearchField, SearchQuery } from '../api/types';
import { useApp } from '../state/app';
import { Menu, Popover, type Anchor } from './ui';
import { plural } from '../lib/text';
import { useSearchSlot } from './TopBar';

const DATE_LABELS: Record<DateFilter, string> = { any: 'any time', week: 'past week', month: 'past month', year: 'past year' };

export const FIELD_LABELS: Record<SearchField, string> = { from: 'From', to: 'To', subject: 'Subject', content: 'Subject + body', all: 'Everything' };
const FIELD_PLACEHOLDERS: Record<SearchField, string> = {
  from: 'Sender name or address',
  to: 'Recipient name or address',
  subject: 'Words in the subject',
  content: 'Words in the subject or body',
  all: 'Search everything',
};

export interface SearchState {
  query: SearchQuery;
  fromName?: string;
  toName?: string;
}

function PersonPicker({ anchor, onPick, onClose }: { anchor: Anchor; onPick: (p: Person) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    api.listPeople(q, 8).then((p) => {
      setPeople(p);
      setActive(0);
    });
  }, [q]);
  return (
    <Popover anchor={anchor} onClose={onClose} width={300}>
      <input
        className="menu-input"
        autoFocus
        placeholder="Name or address"
        aria-label="Person"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setActive((i) => Math.max(0, Math.min(people.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
          }
          if (e.key === 'Enter' && people[active]) {
            onPick(people[active]);
            onClose();
          }
        }}
      />
      {people.map((p, i) => (
        <button
          key={p.email}
          type="button"
          className={`menu-item${i === active ? ' active' : ''}`}
          onClick={() => {
            onPick(p);
            onClose();
          }}
        >
          <span>{p.name}</span>
          <span className="sub">{p.email}</span>
        </button>
      ))}
      {people.length === 0 && <div className="menu-item" style={{ color: 'var(--text-muted)' }}>No matches</div>}
    </Popover>
  );
}

export function SearchHeader({
  state,
  onChange,
  onClose,
  scopeLabel,
  resultCount,
  onSubmit,
  inputRef,
}: {
  state: SearchState;
  onChange: (s: SearchState) => void;
  onClose: () => void;
  scopeLabel: string;
  resultCount: number | null;
  /** Enter in the search box. */
  onSubmit?: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const { graphAccounts, accountById } = useApp();
  const [open, setOpen] = useState<null | { kind: 'from' | 'to' | 'date' | 'account' | 'field'; anchor: HTMLElement }>(null);
  const q = state.query;
  const field = q.field ?? 'all';
  const set = (patch: Partial<SearchQuery>, names?: Partial<SearchState>) => onChange({ ...state, ...names, query: { ...q, ...patch } });
  const local = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? local;
  const slot = useSearchSlot();

  useEffect(() => {
    ref.current?.focus();
  }, [ref]);

  const chip = (active: boolean) => `chip${active ? ' active' : ''}`;
  const toggle = (kind: NonNullable<typeof open>['kind']) => (e: React.MouseEvent<HTMLButtonElement>) => setOpen(open?.kind === kind ? null : { kind, anchor: e.currentTarget });

  // Like Outlook: what to search (From, Subject…) sits outside the box, to its left. In the
  // top bar the search is offset by the same width, so the text box doesn't move when search opens.
  const box = (
    <div className="search-row">
      <button type="button" className="search-scope" title={`Search in: ${FIELD_LABELS[field]}`} aria-label={`Search in: ${FIELD_LABELS[field]}`} aria-haspopup="menu" onClick={toggle('field')}>
        <span className="label">{FIELD_LABELS[field]}</span>
        <ChevronDown size={14} />
      </button>
      <div className="search-box">
        <Search size={16} />
        <input
          ref={ref}
          aria-label={`Search ${FIELD_LABELS[field].toLowerCase()}, ${scopeLabel}`}
          placeholder={FIELD_PLACEHOLDERS[field]}
          value={q.text}
          onChange={(e) => set({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit?.();
            }
          }}
        />
        <button type="button" className="clear-search" aria-label="Clear search" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="search-header">
      {slot ? createPortal(box, slot) : box}
      <div className="facets" role="group" aria-label="Filters">
        {q.from ? (
          <button type="button" className={chip(true)} onClick={() => set({ from: undefined }, { fromName: undefined })}>
            From: {state.fromName ?? q.from}
            <span className="x" aria-label="Remove">
              <X size={13} />
            </span>
          </button>
        ) : (
          <button type="button" className={chip(false)} onClick={toggle('from')}>
            From ▾
          </button>
        )}
        {q.to ? (
          <button type="button" className={chip(true)} onClick={() => set({ to: undefined }, { toName: undefined })}>
            To: {state.toName ?? q.to}
            <span className="x" aria-label="Remove">
              <X size={13} />
            </span>
          </button>
        ) : (
          <button type="button" className={chip(false)} onClick={toggle('to')}>
            To ▾
          </button>
        )}
        <button type="button" className={chip(!!q.hasAttachment)} aria-pressed={!!q.hasAttachment} onClick={() => set({ hasAttachment: !q.hasAttachment })}>
          Has attachment
        </button>
        <button type="button" className={chip(!!q.unread)} aria-pressed={!!q.unread} onClick={() => set({ unread: !q.unread })}>
          Unread
        </button>
        <button type="button" className={chip(!!q.date && q.date !== 'any')} onClick={toggle('date')}>
          Date: {DATE_LABELS[q.date ?? 'any']} ▾
        </button>
        <button type="button" className={chip(!!q.accountId)} onClick={toggle('account')}>
          {q.accountId ? accountById(q.accountId)?.displayName : 'Account'} ▾
        </button>
        <span className="spacer" />
        {resultCount !== null && <span className="count">{plural(resultCount, 'result')}</span>}
      </div>

      {open?.kind === 'from' && <PersonPicker anchor={open.anchor} onClose={() => setOpen(null)} onPick={(p) => set({ from: p.email }, { fromName: p.name })} />}
      {open?.kind === 'to' && <PersonPicker anchor={open.anchor} onClose={() => setOpen(null)} onPick={(p) => set({ to: p.email }, { toName: p.name })} />}
      {open?.kind === 'date' && (
        <Menu
          anchor={open.anchor}
          onClose={() => setOpen(null)}
          items={(Object.keys(DATE_LABELS) as DateFilter[]).map((d) => ({
            label: d === 'any' ? 'Any time' : DATE_LABELS[d].replace(/^\w/, (c) => c.toUpperCase()),
            checked: (q.date ?? 'any') === d,
            onSelect: () => set({ date: d }),
          }))}
        />
      )}
      {open?.kind === 'account' && (
        <Menu
          anchor={open.anchor}
          onClose={() => setOpen(null)}
          items={[
            { label: 'Any account', checked: !q.accountId, onSelect: () => set({ accountId: undefined }) },
            ...graphAccounts.map((a) => ({
              label: a.displayName,
              checked: q.accountId === a.id,
              icon: <span className="acc-dot" style={{ background: a.color }} />,
              onSelect: () => set({ accountId: a.id }),
            })),
          ]}
        />
      )}
      {open?.kind === 'field' && (
        <Menu
          anchor={open.anchor}
          onClose={() => setOpen(null)}
          items={(Object.keys(FIELD_LABELS) as SearchField[]).map((f) => ({
            label: FIELD_LABELS[f],
            checked: field === f,
            onSelect: () => {
              set({ field: f });
              setTimeout(() => ref.current?.focus(), 0);
            },
          }))}
        />
      )}
    </div>
  );
}
