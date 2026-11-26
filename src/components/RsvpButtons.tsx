import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ResponseStatus } from '../api/types';
import { Menu } from './ui';

export type Rsvp = Exclude<ResponseStatus, 'none' | 'organizer'>;
export interface RsvpOptions {
  /** Tell the organiser. */
  sendResponse: boolean;
  /** A note to the organiser with the response. */
  comment?: string;
}

const CHOICES: [Rsvp, string][] = [
  ['accepted', 'Accept'],
  ['tentative', 'Tentative'],
  ['declined', 'Decline'],
];

/**
 * Accept / Tentative / Decline, each with Outlook's choices: send the response now,
 * edit it first (a note to the organiser), or don't send one.
 */
export function RsvpButtons({ current, onRespond, className }: { current: ResponseStatus; onRespond: (r: Rsvp, o: RsvpOptions) => Promise<void> | void; className?: string }) {
  const [menu, setMenu] = useState<{ anchor: HTMLElement; response: Rsvp } | null>(null);
  const [editing, setEditing] = useState<Rsvp | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async (r: Rsvp, o: RsvpOptions) => {
    setBusy(true);
    try {
      await onRespond(r, o);
      setEditing(null);
      setComment('');
    } finally {
      setBusy(false);
    }
  };

  const labelOf = (r: Rsvp) => CHOICES.find(([k]) => k === r)![1];

  return (
    <div className={className ? `rsvp-block ${className}` : 'rsvp-block'}>
      <div className="rsvp" role="group" aria-label="Respond">
        {CHOICES.map(([r, label]) => (
          <button
            key={r}
            type="button"
            className={current === r ? 'on' : ''}
            aria-pressed={current === r}
            aria-haspopup="menu"
            disabled={busy}
            onClick={(e) => setMenu({ anchor: e.currentTarget, response: r })}
          >
            {label}
            <ChevronDown size={13} aria-hidden />
          </button>
        ))}
      </div>
      {editing && (
        <form
          className="rsvp-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void go(editing, { sendResponse: true, comment });
          }}
        >
          <textarea
            className="textarea"
            aria-label={`Note with your ${labelOf(editing).toLowerCase()} response`}
            placeholder="Add a note for the organiser (optional)"
            value={comment}
            autoFocus
            rows={3}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(null);
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void go(editing, { sendResponse: true, comment });
              }
            }}
          />
          <div className="rsvp-edit-actions">
            <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
              Send {labelOf(editing)}
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {menu && (
        <Menu
          anchor={menu.anchor}
          align="start"
          onClose={() => setMenu(null)}
          items={[
            { label: 'Send the response now', onSelect: () => void go(menu.response, { sendResponse: true }) },
            {
              label: 'Edit the response before sending',
              onSelect: () => {
                setComment('');
                setEditing(menu.response);
              },
            },
            { label: 'Don’t send a response', onSelect: () => void go(menu.response, { sendResponse: false }) },
          ]}
        />
      )}
    </div>
  );
}
