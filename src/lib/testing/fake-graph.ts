/**
 * An in-memory stand-in for the slice of Microsoft Graph the Outlook calendar
 * sync uses (COSMOS-202 B2): calendars, events, and a calendarView delta of
 * one calendar. Pass `fetch` as GraphDeps.fetch. `outlookEdit` plays a person
 * changing an event in Outlook; `throttleNext` makes the next calls 429.
 */
export interface FakeEvent {
  id: string;
  calendarId: string;
  changeKey: string;
  subject: string;
  body?: { contentType: string; content: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isCancelled?: boolean;
  lastModifiedDateTime: string;
  transactionId?: string;
  showAs?: string;
  seq: number;
  removed?: boolean;
}

export function fakeGraph(origin = "https://graph.microsoft.com") {
  // Each mailbox is its bearer token: one person never sees another's calendars.
  interface FakeCalendar {
    id: string;
    name: string;
    /** The mailbox (bearer token) it lives in. */
    owner?: string;
    /** Other mailboxes it's shared with (they see it, read-only unless canEdit). */
    sharedWith?: string[];
    canEdit?: boolean;
    props?: { id: string; value: string }[];
  }
  const calendars = new Map<string, FakeCalendar>();
  const addresses = new Map<string, string>();
  const events = new Map<string, FakeEvent>();
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let seq = 0;
  let n = 0;
  let throttle: { count: number; retryAfter: string } | null = null;
  const deltaWindows: { from: string; to: string }[] = [];
  /** Every cancellation an organizer sent: what the attendees were told. */
  const cancellations: { eventId: string; subject: string; comment: string; attendees: unknown[] }[] = [];
  const sleeps: number[] = [];

  const bump = (e: FakeEvent) => {
    e.seq = ++seq;
    e.changeKey = `ck-${e.seq}`;
    e.lastModifiedDateTime = new Date().toISOString();
  };
  const view = (e: FakeEvent) => {
    if (e.removed) return { id: e.id, "@removed": { reason: "deleted" } };
    const { seq: _s, calendarId: _c, removed: _r, ...rest } = e;
    void _s; void _c; void _r;
    return rest;
  };
  const reply = (status: number, json?: unknown, headers: Record<string, string> = {}) =>
    new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { "Content-Type": "application/json", ...headers } });

  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1\.0/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: path + url.search, body });
    const owner = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const mine = (calendarId: string) => calendars.get(calendarId)?.owner === owner;
    const visible = (c: FakeCalendar) => c.owner === owner || !!c.sharedWith?.includes(owner);
    const calView = (c: FakeCalendar) => ({
      id: c.id, name: c.name,
      canEdit: c.owner === owner ? c.canEdit !== false : !!c.canEdit,
      owner: { address: addresses.get(c.owner ?? "") ?? c.owner },
      singleValueExtendedProperties: c.props ?? [],
    });
    if (throttle && throttle.count > 0) {
      throttle.count--;
      return reply(429, { error: { code: "TooManyRequests" } }, { "Retry-After": throttle.retryAfter });
    }
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/me/calendars") {
      return reply(200, { value: [...calendars.values()].filter(visible).map(calView) });
    }
    if (method === "POST" && path === "/me/calendars") {
      // Like Graph: a second calendar with the same name is refused.
      if ([...calendars.values()].some((c) => c.owner === owner && c.name === body?.name)) {
        return reply(409, { error: { code: "ErrorFolderExists" } });
      }
      const id = `cal-${++n}`;
      calendars.set(id, { id, name: String(body?.name), owner, props: body?.singleValueExtendedProperties as FakeCalendar["props"] });
      return reply(201, { id, name: body?.name });
    }
    if ((m = path.match(/^\/me\/calendars\/([^/]+)$/)) && method === "GET") {
      const c = calendars.get(decodeURIComponent(m[1]));
      return c && visible(c) ? reply(200, calView(c)) : reply(404, { error: { code: "ErrorItemNotFound" } });
    }
    if ((m = path.match(/^\/me\/calendars\/([^/]+)$/)) && method === "DELETE") {
      const id = decodeURIComponent(m[1]);
      if (!mine(id) || !calendars.delete(id)) return reply(404, { error: { code: "ErrorItemNotFound" } });
      for (const e of events.values()) if (e.calendarId === id) events.delete(e.id);
      return reply(204);
    }
    if ((m = path.match(/^\/me\/calendars\/([^/]+)\/events$/)) && method === "POST") {
      const calendarId = decodeURIComponent(m[1]);
      if (!mine(calendarId)) return reply(404, { error: { code: "ErrorItemNotFound" } });
      const existing = [...events.values()].find((e) => !e.removed && e.calendarId === calendarId && body?.transactionId && e.transactionId === body.transactionId);
      if (existing) return reply(201, view(existing)); // Graph dedupes on transactionId
      const e = { ...(body as object), id: `ev-${++n}`, calendarId } as FakeEvent;
      bump(e);
      events.set(e.id, e);
      return reply(201, view(e));
    }
    if ((m = path.match(/^\/me\/events\/([^/]+)\/cancel$/)) && method === "POST") {
      // The organizer cancels: attendees are sent a cancellation, and it leaves their calendar.
      const e = events.get(decodeURIComponent(m[1]));
      if (!e || e.removed || !mine(e.calendarId)) return reply(404, { error: { code: "ErrorItemNotFound" } });
      cancellations.push({ eventId: e.id, subject: e.subject, comment: String(body?.comment ?? ""), attendees: (e as { attendees?: unknown[] }).attendees ?? [] });
      e.removed = true;
      e.seq = ++seq;
      return reply(202);
    }
    if ((m = path.match(/^\/me\/events\/([^/]+)$/))) {
      const e = events.get(decodeURIComponent(m[1]));
      if (!e || e.removed || !mine(e.calendarId)) return reply(404, { error: { code: "ErrorItemNotFound" } });
      if (method === "GET") return reply(200, view(e));
      if (method === "PATCH") {
        Object.assign(e, body);
        bump(e);
        return reply(200, view(e));
      }
      if (method === "DELETE") {
        e.removed = true;
        e.seq = ++seq;
        return reply(204);
      }
    }
    if ((m = path.match(/^\/me\/calendars\/([^/]+)\/calendarView\/delta$/)) && method === "GET") {
      const calendarId = decodeURIComponent(m[1]);
      if (!mine(calendarId)) return reply(404, { error: { code: "ErrorItemNotFound" } });
      // The window rides along in the delta token, as Graph's does.
      const token = url.searchParams.get("$deltatoken");
      const [since, from, to] = token
        ? token.split("_")
        : ["0", url.searchParams.get("startDateTime") ?? "", url.searchParams.get("endDateTime") ?? ""];
      const inWindow = (e: FakeEvent) => {
        const t = Date.parse(e.start.dateTime + (e.start.dateTime.endsWith("Z") ? "" : "Z"));
        return (!from || t >= Date.parse(from)) && (!to || t <= Date.parse(to));
      };
      deltaWindows.push({ from, to });
      const value = [...events.values()]
        .filter((e) => e.calendarId === calendarId && e.seq > Number(since))
        // Changed and now outside the window: Graph reports it as removed.
        .map((e) => (e.removed || inWindow(e) ? view(e) : { id: e.id, "@removed": { reason: "deleted" } }));
      return reply(200, { value, "@odata.deltaLink": `${origin}/v1.0${path}?$deltatoken=${[seq, from, to].join("_")}` });
    }
    return reply(400, { error: { code: "unsupported" } });
  }) as unknown as typeof fetch;

  return {
    fetch: fetchFn,
    calls,
    calendars,
    events,
    sleeps,
    /** The address a mailbox's own calendars report as their owner. */
    setAddress(token: string, address: string) {
      addresses.set(token, address);
    },
    /** A calendar we didn't make: the person's own, or one shared with them. */
    addCalendar(c: Omit<FakeCalendar, "id"> & { id?: string }) {
      const id = c.id ?? `cal-${++n}`;
      calendars.set(id, { ...c, id });
      return id;
    },
    /** An event someone put in a calendar themselves. */
    addEvent(calendarId: string, subject: string) {
      const e = { id: `ev-${++n}`, calendarId, subject, start: { dateTime: "2026-11-01T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-01T10:00:00.0000000", timeZone: "UTC" } } as FakeEvent;
      bump(e);
      events.set(e.id, e);
      return e.id;
    },
    cancellations,
    /** The window of every delta read, in order. */
    deltaWindows,
    sleep: async (ms: number) => void sleeps.push(ms),
    eventsIn: (calendarId: string) => [...events.values()].filter((e) => e.calendarId === calendarId && !e.removed),
    /** A person editing the event in Outlook. */
    outlookEdit(id: string, patch: Partial<FakeEvent>) {
      const e = events.get(id)!;
      Object.assign(e, patch);
      bump(e);
    },
    /** A person deleting the event in Outlook. */
    outlookDelete(id: string) {
      const e = events.get(id)!;
      e.removed = true;
      e.seq = ++seq;
    },
    throttleNext(count: number, retryAfter = "1") {
      throttle = { count, retryAfter };
    },
  };
}
