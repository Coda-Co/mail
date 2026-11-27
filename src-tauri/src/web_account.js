// Injected into Outlook on the web (web accounts only). Reports the Inbox unread
// count, forwards web notifications to the app and, when the app asks, reads the
// calendar for a date range (docs/WEB_CALENDAR.md). Best effort: Outlook's markup and
// internal calls are not an API, so when something can't be read we report null or an
// error code, and mail, the count and notifications carry on regardless.
(() => {
  if (window.top !== window) return;
  // Outlook on the web: outlook.cloud.microsoft (current), and the older office.com hosts.
  if (!/^outlook\.cloud\.microsoft$|(^|\.)outlook\.(office|office365|live)\.com$/.test(location.hostname)) return;
  const invoke = (cmd, args) => {
    try {
      const t = window.__TAURI_INTERNALS__;
      if (t && typeof t.invoke === 'function') t.invoke(cmd, args).catch(() => {});
    } catch (_) {}
  };

  // --- the app's view shortcuts (Ctrl+1–9, Cmd on macOS): keys pressed in this page never
  // reach the app's interface, so hand them over. Taken before Outlook sees them, as Outlook
  // has its own Ctrl+1/2/3 (Mail, Calendar, People) that would otherwise switch inside the page.
  const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing || e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return;
      const m = /^Digit([1-9])$/.exec(e.code) || /^([1-9])$/.exec(e.key);
      if (!m) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      invoke('web_account_shortcut', { digit: Number(m[1]) });
    },
    true,
  );

  // --- unread count
  const num = (s) => {
    const m = String(s || '').match(/(\d[\d,.]*)/);
    return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : NaN;
  };
  // Text of a folder item without its subfolders (expanded tree items nest them).
  const ownText = (el) => {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1 && !n.matches('[role="group"], [role="treeitem"]')) out += ' ' + ownText(n);
    }
    return out;
  };
  // Outlook's class names are generated, so look for the count by content: "4 unread" in a
  // label or screen-reader text, else a leaf element whose whole text is a number ("4", "99+").
  function countIn(el) {
    for (const s of [el.getAttribute('aria-label'), el.getAttribute('title'), ownText(el)]) {
      const m = String(s || '').match(/(\d[\d,.]*)\+?\s+unread/i);
      if (m) return num(m[1]);
    }
    const walk = (node) => {
      for (const c of node.children) {
        if (c.matches('[role="group"], [role="treeitem"]')) continue;
        if (c.children.length === 0 && /^\s*\d[\d,.]*\+?\s*$/.test(c.textContent || '')) return num(c.textContent);
        const n = walk(c);
        if (n !== null) return n;
      }
      return null;
    };
    return walk(el);
  }
  function readUnread() {
    const items = document.querySelectorAll('[role="treeitem"], [role="option"], [data-folder-name]');
    let found = false;
    for (const el of items) {
      const name = (el.getAttribute('data-folder-name') || el.getAttribute('title') || el.getAttribute('aria-label') || ownText(el) || '').trim();
      // "Inbox", "Inbox 4", "Inbox4" (text runs together), "Inbox, 4 unread"; not "Inbox rules".
      if (!/^inbox(?![a-z])(?!\s+[a-z])/i.test(name)) continue;
      found = true;
      const n = countIn(el);
      // Favorites and the folder list both show Inbox; take the first that shows a count.
      if (n !== null && !Number.isNaN(n)) return n;
    }
    // Some builds put "(3)" in the title.
    const t = document.title.match(/\((\d+)\)/);
    if (t) return parseInt(t[1], 10);
    // Inbox found with no badge: Outlook hides the badge at zero.
    return found ? 0 : null;
  }
  let last;
  const tick = () => {
    const n = readUnread();
    if (n !== last) {
      last = n;
      invoke('web_account_report', { unread: n });
    }
  };
  setInterval(tick, 5000);
  document.addEventListener('visibilitychange', tick);

  // --- web notifications → desktop notifications labelled with the account
  function AppNotification(title, options) {
    invoke('web_account_notify', { title: String(title || ''), body: String((options && options.body) || '') });
    this.title = title;
    this.onclick = null;
    this.close = () => {};
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
  }
  AppNotification.permission = 'granted';
  AppNotification.requestPermission = (cb) => {
    if (typeof cb === 'function') cb('granted');
    return Promise.resolve('granted');
  };
  try {
    Object.defineProperty(window, 'Notification', { value: AppNotification, configurable: true, writable: true });
  } catch (_) {
    window.Notification = AppNotification;
  }

  // --- calendar (docs/WEB_CALENDAR.md)
  // The app calls window.__mailCalendarFetch(start, end, requestId) when this account's
  // "Show this calendar in Calendar" toggle is on. Same-origin requests only, using what the
  // page already has. Only normalised event data goes back: never a token, cookie or header.
  const CAL_TIMEOUT_MS = 30000;
  const CAL_MAX = 2000;
  const CAL_SLICE_MS = 7 * 86400000;

  class CalError extends Error {}
  const fail = (code) => new CalError(code);
  const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  // Case-insensitive property lookup: Outlook's internal calls use PascalCase, REST camelCase.
  const get = (o, ...names) => {
    if (!o || typeof o !== 'object') return undefined;
    for (const n of names) {
      if (n in o) return o[n];
      const k = Object.keys(o).find((x) => x.toLowerCase() === n.toLowerCase());
      if (k !== undefined) return o[k];
    }
    return undefined;
  };

  // Taken before Outlook's own code runs, so our requests don't pass through its fetch wrappers.
  const nativeFetch = window.fetch.bind(window);

  const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

  // Outlook's own access token, read the way the page's sign-in library (MSAL) reads it: from
  // its local storage cache, decrypted with the key MSAL keeps in the msal.cache.encryption
  // cookie (HKDF-SHA-256 with the entry's nonce and client id, then AES-GCM). Only access tokens
  // for https://outlook.office.com/ are read; refresh and id tokens are never touched. The token
  // is read at the time of the call, used for same-origin requests only, kept in no variable
  // beyond the call, and never passed to the app. See docs/WEB_CALENDAR.md §2 and §8.
  async function outlookToken() {
    const now = Date.now() / 1000;
    const keys = Object.keys(localStorage).filter((k) => /\|accesstoken\|/i.test(k) && /https:\/\/outlook\.office\.com\//i.test(k));
    if (!keys.length) throw fail('no_token');
    // Prefer a token that names calendar access.
    keys.sort((a, b) => Number(/calendars\.read/i.test(b)) - Number(/calendars\.read/i.test(a)));
    let base = null;
    const raw = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('msal.cache.encryption='));
    let cookie = null;
    if (raw) {
      try {
        cookie = JSON.parse(decodeURIComponent(raw.slice('msal.cache.encryption='.length)));
        base = await crypto.subtle.importKey('raw', b64url(cookie.key), 'HKDF', false, ['deriveKey']);
      } catch (_) {
        base = null;
      }
    }
    for (const k of keys) {
      try {
        const entry = JSON.parse(localStorage.getItem(k) || 'null');
        if (!entry) continue;
        let cred = entry;
        if (entry.data && entry.nonce) {
          // Encrypted entry (MSAL 4+).
          if (!base || (cookie && entry.id && entry.id !== cookie.id)) continue;
          const clientId = k.split('|')[4] || '';
          const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: b64url(entry.nonce), info: new TextEncoder().encode(clientId) }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
          cred = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, aes, b64url(entry.data))));
        }
        if (String(cred.credentialType).toLowerCase() !== 'accesstoken' || typeof cred.secret !== 'string') continue;
        if (Number(cred.expiresOn) < now + 120) continue;
        return cred.secret;
      } catch (_) {
        /* try the next entry */
      }
    }
    throw fail('no_token');
  }

  // One Outlook on the web service.svc call (header form, Outlook's own token), the way its
  // Calendar makes them (checked 24-25 Nov 2026, docs/WEB_CALENDAR.md §8). Returns parsed JSON.
  async function serviceCall(action, body, token, signal) {
    const url = new URL('/owa/service.svc?action=' + action + '&app=Calendar', location.origin);
    if (url.origin !== location.origin) throw fail('unsupported');
    let res;
    try {
      res = await nativeFetch(url.href, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        signal,
        // Like Outlook itself: the request goes in a header, with no body.
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json; charset=utf-8',
          Action: action,
          'x-req-source': 'Calendar',
          'x-owa-urlpostdata': encodeURIComponent(JSON.stringify(body)),
        },
      });
    } catch (_) {
      throw fail(signal && signal.aborted ? 'timeout' : 'network');
    }
    // A redirect or 440 means the session ended; 401 means the token was refused.
    if (res.type === 'opaqueredirect' || res.status === 440) throw fail('signed_out');
    if (!res.ok) throw fail('http_' + res.status);
    try {
      return await res.json();
    } catch (_) {
      throw fail('parse');
    }
  }

  // The one place that knows how Outlook on the web loads a range of events: the request its
  // Calendar makes (checked 24 Nov 2026, docs/WEB_CALENDAR.md §8), with Outlook's own token.
  async function fetchCalendarRange(start, end, token, signal) {
    const body = {
      __type: 'GetCalendarViewJsonRequest:#Exchange',
      Header: {
        __type: 'JsonRequestHeaders:#Exchange',
        RequestServerVersion: 'V2018_01_08',
        TimeZoneContext: { __type: 'TimeZoneContext:#Exchange', TimeZoneDefinition: { __type: 'TimeZoneDefinitionType:#Exchange', Id: 'UTC' } },
      },
      Body: {
        __type: 'GetCalendarViewRequest:#Exchange',
        CalendarId: { __type: 'TargetFolderId:#Exchange', BaseFolderId: { __type: 'DistinguishedFolderId:#Exchange', Id: 'calendar' } },
        RangeStart: start,
        RangeEnd: end,
      },
    };
    const items = findItems(await serviceCall('GetCalendarView', body, token, signal));
    if (!items) throw fail('unsupported');
    return items;
  }

  // The attendees for one event: the calendar view doesn't carry them, so ask GetItem for them
  // (docs/WEB_CALENDAR.md §8). Only done when an event is opened. Outlook's JSON form of the
  // property names isn't confirmed, so try the plain names Outlook itself uses ("RequiredAttendees"),
  // then the EWS form ("calendar:RequiredAttendees"), then the default calendar item shape, and keep
  // the first answer that isn't an error. Only names, emails and responses are kept.
  const ATTENDEE_FIELDS = ['RequiredAttendees', 'OptionalAttendees', 'Resources', 'Organizer'];
  const ATTENDEE_SHAPES = [
    { BaseShape: 'IdOnly', fields: ATTENDEE_FIELDS },
    { BaseShape: 'IdOnly', fields: ATTENDEE_FIELDS.map((f) => 'calendar:' + f) },
    { BaseShape: 'Default', fields: [] },
  ];
  function getItemBody(id, shape) {
    return {
      __type: 'GetItemJsonRequest:#Exchange',
      Header: {
        __type: 'JsonRequestHeaders:#Exchange',
        RequestServerVersion: 'V2018_01_08',
        TimeZoneContext: { __type: 'TimeZoneContext:#Exchange', TimeZoneDefinition: { __type: 'TimeZoneDefinitionType:#Exchange', Id: 'UTC' } },
      },
      Body: {
        __type: 'GetItemRequest:#Exchange',
        ItemShape: {
          __type: 'ItemResponseShape:#Exchange',
          BaseShape: shape.BaseShape,
          AdditionalProperties: shape.fields.map((f) => ({ __type: 'PropertyUri:#Exchange', FieldURI: f })),
        },
        ItemIds: [{ __type: 'ItemId:#Exchange', Id: id }],
      },
    };
  }
  // The response message's error, if the server answered with one (EWS: ResponseClass "Error").
  function responseError(data) {
    const m = get(get(get(data, 'Body') || data, 'ResponseMessages'), 'Items');
    const first = Array.isArray(m) && m[0];
    if (first && /^error$/i.test(text(get(first, 'ResponseClass')))) return text(get(first, 'ResponseCode')) || 'error';
    return '';
  }
  async function fetchEventAttendees(id, token, signal) {
    let lastError = fail('unsupported');
    for (const shape of ATTENDEE_SHAPES) {
      let data;
      try {
        data = await serviceCall('GetItem', getItemBody(id, shape), token, signal);
      } catch (e) {
        // Signed out / timed out won't get better with another shape.
        if (e instanceof CalError && /^(signed_out|timeout|network|http_401)$/.test(e.message)) throw e;
        lastError = e;
        continue;
      }
      const err = responseError(data);
      const items = !err && findItems(data);
      const it = Array.isArray(items) && items[0];
      if (!it) {
        lastError = fail(err ? 'server_' + err.replace(/[^A-Za-z0-9]/g, '').slice(0, 60) : 'unsupported');
        continue;
      }
      const list = [];
      const add = (arr, type) => {
        if (!Array.isArray(arr)) return;
        for (const a of arr) list.push({ ...person(a), type, response: response(get(a, 'ResponseType', 'Status')) });
      };
      add(get(it, 'RequiredAttendees'), 'required');
      add(get(it, 'OptionalAttendees'), 'optional');
      add(get(it, 'Resources'), 'resource');
      return list;
    }
    throw lastError;
  }

  function findItems(data) {
    const body = get(data, 'Body') || data;
    const direct = get(body, 'Items') || get(data, 'value');
    if (Array.isArray(direct)) return direct;
    const messages = get(get(body, 'ResponseMessages'), 'Items');
    if (Array.isArray(messages) && messages.length) {
      const m = messages[0];
      const items = get(m, 'Items') || get(get(m, 'RootFolder'), 'Items');
      if (Array.isArray(items)) return items;
    }
    return null;
  }

  const RESPONSES = { organizer: 'organizer', accept: 'accepted', accepted: 'accepted', tentative: 'tentative', tentativelyaccepted: 'tentative', decline: 'declined', declined: 'declined' };
  // EWS: 'Accept'; REST: { Response: 'Accepted' }.
  const response = (v) => RESPONSES[text(get(v, 'Response') ?? v).toLowerCase()] || 'none';
  const SHOW_AS = { free: 'free', tentative: 'tentative', busy: 'busy', oof: 'oof', workingelsewhere: 'workingElsewhere' };

  // EWS: { Mailbox: { Name, EmailAddress } }; REST: { EmailAddress: { Name, Address } }.
  const person = (p) => {
    const m = get(p, 'Mailbox') || get(p, 'EmailAddress') || p;
    return { name: text(get(m, 'Name')), email: text(get(m, 'EmailAddress', 'Address')) };
  };

  // RFC 3339 in UTC, or null when the time has no zone we can trust.
  function instant(v) {
    const raw = text(get(v, 'DateTime') ?? v).replace(/(\.\d{3})\d+/, '$1');
    if (!raw) return null;
    let s = raw;
    if (!/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s)) {
      if (!/^(utc|coordinated universal time)$/i.test(text(get(v, 'TimeZone')))) return null;
      s += 'Z';
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  const pad = (n) => String(n).padStart(2, '0');
  // All-day events as a date. A zoned midnight is rounded to the nearest local midnight, so
  // an event made in another time zone still lands on its own day.
  function day(v) {
    const raw = text(get(v, 'DateTime') ?? v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const iso = instant(v);
    if (iso) {
      const d = new Date(Date.parse(iso) + 12 * 3600000);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})T00:00/);
    return m ? m[1] : null;
  }

  // The online-meeting join link as it appears in the event body/preview. Only well-known
  // conferencing hosts, https only; the core validates the scheme again before storing it.
  const MEETING_HOSTS = /^(?:teams\.microsoft\.com|teams\.live\.com|.*\.zoom\.us|zoom\.us|meet\.google\.com|.*\.webex\.com|.*\.gotomeeting\.com)$/i;
  function joinUrlFromText(s) {
    if (!s) return '';
    for (const m of s.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) {
      try {
        const u = new URL(m[0].replace(/[.,;]+$/, ''));
        if (MEETING_HOSTS.test(u.hostname)) return u.href;
      } catch (_) {}
    }
    return '';
  }

  function normalise(it) {
    const id = text(get(get(it, 'ItemId'), 'Id')) || text(get(it, 'Id'));
    const allDay = !!get(it, 'IsAllDayEvent', 'IsAllDay');
    const start = allDay ? day(get(it, 'Start')) : instant(get(it, 'Start'));
    const end = allDay ? day(get(it, 'End')) : instant(get(it, 'End'));
    if (!id || !start || !end) return null;
    const loc = get(it, 'Location');
    const attendees = [];
    const add = (list, type) => {
      if (!Array.isArray(list)) return;
      for (const a of list) {
        const kind = type || text(get(a, 'Type')).toLowerCase();
        attendees.push({ ...person(a), type: kind === 'optional' || kind === 'resource' ? kind : 'required', response: response(get(a, 'ResponseType', 'Status')) });
      }
    };
    add(get(it, 'RequiredAttendees'), 'required');
    add(get(it, 'OptionalAttendees'), 'optional');
    add(get(it, 'Resources'), 'resource');
    add(get(it, 'Attendees'), '');
    // The calendar view carries no join link in a field, but the body preview holds the
    // provider's own "Join: <url>" line (Teams, Zoom, Meet, Webex). Fall back to that.
    const url =
      text(get(it, 'OnlineMeetingJoinUrl', 'JoinOnlineMeetingUrl', 'OnlineMeetingUrl', 'SkypeTeamsMeetingUrl')) ||
      text(get(get(it, 'OnlineMeeting'), 'JoinUrl')) ||
      joinUrlFromText(text(get(it, 'Preview', 'BodyPreview')) || text(get(get(it, 'Body'), 'Value')));
    const showAs = SHOW_AS[text(get(it, 'FreeBusyType', 'LegacyFreeBusyStatus', 'ShowAs')).toLowerCase()];
    const ev = {
      id,
      subject: text(get(it, 'Subject')),
      start,
      end,
      isAllDay: allDay,
      location: typeof loc === 'string' ? loc : text(get(loc, 'DisplayName')),
      organizer: person(get(it, 'Organizer')),
      attendees,
      // Calendar view items carry the user's own response as ResponseType.
      myResponse: get(it, 'IsOrganizer') === true ? 'organizer' : response(get(it, 'MyResponseType', 'ResponseType', 'ResponseStatus')),
      isOnlineMeeting: !!get(it, 'IsOnlineMeeting') || !!url,
      isCancelled: !!get(it, 'IsCancelled'),
    };
    if (url) ev.onlineMeetingUrl = url;
    if (showAs) ev.showAs = showAs;
    return ev;
  }

  // Just after a start Outlook may still be fetching its tokens: wait up to ~20 s for one.
  async function waitForToken(signal, maxTries = 10) {
    for (let tries = 0; ; tries++) {
      try {
        return await outlookToken();
      } catch (err) {
        if (tries >= maxTries || (signal && signal.aborted)) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // The range in week-long slices (the server's own paging is unknown), deduplicated by id.
  async function readRange(start, end, signal) {
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw fail('unsupported');
    const token = await waitForToken(signal);
    const byId = new Map();
    let seen = 0;
    for (let t = s; t < e; t += CAL_SLICE_MS) {
      const items = await fetchCalendarRange(new Date(t).toISOString(), new Date(Math.min(e, t + CAL_SLICE_MS)).toISOString(), token, signal);
      seen += items.length;
      if (seen > CAL_MAX * 4) throw fail('too_many');
      for (const it of items) {
        const ev = normalise(it);
        if (ev) byId.set(ev.id, ev);
      }
      if (byId.size > CAL_MAX) throw fail('too_many');
    }
    return [...byId.values()];
  }

  let calRun = null;
  function calendarFetch(start, end, requestId) {
    if (calRun) calRun.abort();
    const ctrl = new AbortController();
    calRun = ctrl;
    const timer = setTimeout(() => ctrl.abort(), CAL_TIMEOUT_MS);
    const report = (events, error) => invoke('web_account_calendar_report', { requestId: String(requestId), start: String(start), end: String(end), events, error });
    readRange(String(start), String(end), ctrl.signal)
      .then((events) => report(events, null))
      .catch((e) => report([], e instanceof CalError ? e.message : ctrl.signal.aborted ? 'timeout' : 'parse'))
      .finally(() => {
        clearTimeout(timer);
        if (calRun === ctrl) calRun = null;
      });
  }
  // The app calls this when an event is opened (web accounts, calendar toggle on). It asks the
  // server for just this event's attendees and reports them back with the same request id, the
  // way calendarFetch does. Same-origin only; only attendee names, emails and responses cross.
  const ATT_TIMEOUT_MS = 20000;
  function eventAttendeesFetch(eventId, requestId) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATT_TIMEOUT_MS);
    const report = (attendees, error) => invoke('web_account_event_attendees_report', { requestId: String(requestId), attendees, error });
    (async () => {
      const token = await waitForToken(ctrl.signal, 2);
      return fetchEventAttendees(String(eventId), token, ctrl.signal);
    })()
      .then((attendees) => report(attendees, null))
      .catch((e) => report([], e instanceof CalError ? e.message : ctrl.signal.aborted ? 'timeout' : 'parse'))
      .finally(() => clearTimeout(timer));
  }
  try {
    Object.defineProperty(window, '__mailCalendarFetch', { value: calendarFetch, enumerable: false, configurable: false, writable: false });
    Object.defineProperty(window, '__mailEventAttendees', { value: eventAttendeesFetch, enumerable: false, configurable: false, writable: false });
  } catch (_) {}
})();
