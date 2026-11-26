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

/** Recent mail shown with a person, then this many more per Show more. */
const RECENT = 10;
const MORE = 20;

export function PeopleView() {
  const app = useApp();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [allPeople, setPeople] = useState<Person[] | null>(null);
  // The account picked in the top bar's tabs (shared with Mail); web accounts have no contacts here.
  const account = app.graphAccounts.find((a) => a.id === app.scope.accountId)?.id ?? app.graphAccounts[0]?.id;
  const people = allPeople && account ? allPeople.filter((p) => p.accountIds.includes(account)) : allPeople;
  const selectedEmail = app.route.param ?? null;
  const [person, setPerson] = useState<Person | null>(null);
  // Recent mail with the selected person; null while loading.
  const [recent, setRecent] = useState<MessageSummary[] | null>(null);
  const [recentFailed, setRecentFailed] = useState(false);
  // How many to show: the latest few, and Show more for the next lot.
  const [limit, setLimit] = useState(RECENT);
  const [retry, setRetry] = useState(0);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => api.listPeople(q, 200).then(setPeople), 80);
    return () => clearTimeout(t);
  }, [q, app.mailVersion]);

  useEffect(() => {
    // A new person: clear the last one's mail and start from the latest few. A sync (or Show
    // more) refreshes in place, without the spinner.
    if (loadedFor.current !== selectedEmail) {
      setRecent(null);
      if (limit !== RECENT) {
        loadedFor.current = selectedEmail;
        setLimit(RECENT);
        return;
      }
    }
    loadedFor.current = selectedEmail;
    if (!selectedEmail) {
      setPerson(null);
      return;
    }
    let cancelled = false;
    // Show them at once from the list we already have; the full record follows.
    const listed = people?.find((p) => p.email.toLowerCase() === selectedEmail.toLowerCase());
    setPerson((cur) => (cur?.email.toLowerCase() === selectedEmail.toLowerCase() ? cur : (listed ?? null)));
    api.getPerson(selectedEmail).then((p) => !cancelled && p && setPerson(p));
    // Its own query, not two searches: a search started meanwhile used to cancel one of them,
    // and then this showed no mail at all.
    // One more than shown, to know whether there's more.
    api.personMail(selectedEmail, account, limit + 1).then(
      (list) => {
        if (cancelled) return;
        setRecentFailed(false);
        setRecent(list);
      },
      () => {
        if (cancelled) return;
        setRecentFailed(true);
        setRecent([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail, account, app.mailVersion, limit, retry]);

  // Switching account: a person who isn't in it is put down.
  useEffect(() => {
    if (selectedEmail && people && !people.some((p) => p.email.toLowerCase() === selectedEmail.toLowerCase())) app.navigate({ view: 'people' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, allPeople]);

  const select = (email: string | null) => app.navigate(email ? { view: 'people', param: email } : { view: 'people' });

  const email = async (p: Person) => {
    const d = await api.createDraft({ mode: 'new', accountId: account && p.accountIds.includes(account) ? account : p.accountIds[0] });
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
              {recent?.slice(0, limit).map((m) => (
                <MessageRow key={m.id} m={m} selected={false} onSelect={() => api.popOut('message', m.id)} />
              ))}
              {recent && recent.length > limit && (
                <button type="button" className="agenda-more person-more" onClick={() => setLimit((n) => n + MORE)}>
                  Show more
                </button>
              )}
              {recentFailed && (
                <div className="list-empty">
                  Couldn’t load mail with {person.name || person.email}.{' '}
                  <button type="button" className="link-button" onClick={() => setRetry((n) => n + 1)}>
                    Try again
                  </button>
                </div>
              )}
              {!recentFailed && recent?.length === 0 && <div className="list-empty">No mail with {person.name || person.email} yet</div>}
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
