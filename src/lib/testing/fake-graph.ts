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
  const calendars = new Map<string, { id: string; name: string; owner?: string }>();
  const events = new Map<string, FakeEvent>();
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let seq = 0;
  let n = 0;
  let throttle: { count: number; retryAfter: string } | null = null;
  const deltaWindows: { from: string; to: string }[] = [];
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
    if (throttle && throttle.count > 0) {
      throttle.count--;
      return reply(429, { error: { code: "TooManyRequests" } }, { "Retry-After": throttle.retryAfter });
    }
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/me/calendars") {
      return reply(200, { value: [...calendars.values()].filter((c) => c.owner === owner).map(({ id, name }) => ({ id, name })) });
    }
    if (method === "POST" && path === "/me/calendars") {
      // Like Graph: a second calendar with the same name is refused.
      if ([...calendars.values()].some((c) => c.owner === owner && c.name === body?.name)) {
        return reply(409, { error: { code: "ErrorFolderExists" } });
      }
      const id = `cal-${++n}`;
      calendars.set(id, { id, name: String(body?.name), owner });
      return reply(201, { id, name: body?.name });
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
      const existing = [...events.values()].find((e) => !e.removed && body?.transactionId && e.transactionId === body.transactionId);
      if (existing) return reply(201, view(existing)); // Graph dedupes on transactionId
      const e = { ...(body as object), id: `ev-${++n}`, calendarId } as FakeEvent;
      bump(e);
      events.set(e.id, e);
      return reply(201, view(e));
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
