import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import type { MessageSummary, Person } from '../api/types';
import { useApp } from '../state/app';
import { Avatar, useToast } from '../components/ui';
import { TopSearch } from '../components/TopSearch';
import { MessageRow } from '../components/MessageList';
import { listTime } from '../lib/dates';
import { plural } from '../lib/text';

export function PeopleView() {
  const app = useApp();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);
  const selectedEmail = app.route.param ?? null;
  const [person, setPerson] = useState<Person | null>(null);
  // Recent mail with the selected person; null while loading.
  const [recent, setRecent] = useState<MessageSummary[] | null>(null);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => api.listPeople(q, 200).then(setPeople), 80);
    return () => clearTimeout(t);
  }, [q, app.mailVersion]);

  useEffect(() => {
    // A new person: clear the last one's mail. A sync refreshes in place, without the spinner.
    if (loadedFor.current !== selectedEmail) setRecent(null);
    loadedFor.current = selectedEmail;
    if (!selectedEmail) {
      setPerson(null);
      return;
    }
    let cancelled = false;
    api.getPerson(selectedEmail).then((p) => !cancelled && setPerson(p));
    const scope = { folder: { role: 'inbox' as const }, tab: 'all' as const };
    Promise.all([
      api.search({ text: '', scope, allFolders: true, from: selectedEmail }),
      api.search({ text: '', scope, allFolders: true, to: selectedEmail }),
    ]).then(
      ([a, b]) => {
        if (cancelled) return;
        const all = [...a.messages, ...b.messages.filter((m) => !a.messages.some((x) => x.id === m.id))];
        setRecent(all.sort((x, y) => y.receivedAt.localeCompare(x.receivedAt)).slice(0, 30));
      },
      () => !cancelled && setRecent([]),
    );
    return () => {
      cancelled = true;
    };
  }, [selectedEmail, app.mailVersion]);

  const select = (email: string | null) => app.navigate(email ? { view: 'people', param: email } : { view: 'people' });

  const email = async (p: Person) => {
    const d = await api.createDraft({ mode: 'new', accountId: p.accountIds[0] });
    await api.updateDraft({ ...d, to: [{ name: p.name, email: p.email }] });
    await api.popOut('draft', d.id);
  };

  return (
    <div className={`people-view${selectedEmail ? ' has-selection' : ''}`}>
      <TopSearch value={q} onChange={setQ} placeholder="Search people" />
      <section className="people-list" aria-label="People">
        <div className="message-rows">
          {people === null && <div className="list-empty">Loading…</div>}
          {people?.length === 0 && <div className="list-empty">{q ? 'No one matches' : 'People appear here as mail syncs'}</div>}
          {people?.map((p) => (
            <button key={p.email} type="button" className={`person-row${p.email === selectedEmail ? ' selected' : ''}`} onClick={() => select(p.email)}>
              <Avatar name={p.name} small />
              <span className="info">
                <span className="name">{p.name}</span>
                <span className="email">{p.email}</span>
              </span>
              <span className="squares">
                {p.accountIds.map((id) => (
                  <span key={id} className="acc-dot" style={{ background: app.accountById(id)?.color }} title={app.accountById(id)?.displayName} />
                ))}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="person-detail" aria-label="Person">
        {person ? (
          <>
            <button type="button" className="btn btn-ghost back-button" style={{ alignSelf: 'flex-start' }} onClick={() => select(null)}>
              <ArrowLeft size={15} /> People
            </button>
            <div className="head">
              <Avatar name={person.name} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2>{person.name}</h2>
                <div className="meta">
                  {person.email} · {plural(person.messageCount, 'message')} · last {listTime(person.lastContactAt)}
                </div>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => email(person)}>
                Email
              </button>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(person.email).catch(() => {});
                  toast(`Copied ${person.email}`);
                }}
              >
                Copy address
              </button>
            </div>
            <div className="section-title">Recent mail</div>
            <div className="message-rows">
              {recent === null && (
                <div className="list-empty">
                  <span className="list-searching" role="status">
                    <LoaderCircle size={16} className="spin" aria-hidden />
                    Loading recent mail…
                  </span>
                </div>
              )}
              {recent?.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  selected={false}
                  onSelect={() => api.popOut('message', m.id)}
                />
              ))}
              {recent?.length === 0 && <div className="list-empty">No messages in the offline window</div>}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <span className="title">People you write to</span>
            <span className="body">Built from the people in your mail across all accounts, ranked by how recently and often you correspond. Nothing to maintain.</span>
          </div>
        )}
      </section>
    </div>
  );
}
