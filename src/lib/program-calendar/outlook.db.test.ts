// @vitest-environment node
//
// The Outlook overlay reads a person's own mailbox. The rule that matters is
// whose: always the viewer's, through the viewer's own connection, and only
// their MAIN calendar. Built against the in-memory Graph (`fakeGraph`), which
// answers each bearer token for its own mailbox only, as Microsoft does.
//
// Every refusal is paired with someone entitled to the same thing who gets it,
// so no case passes by the overlay simply returning nothing.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { fakeGraph, type FakeEvent } from "@/lib/testing/fake-graph";
import { MS_CALENDAR } from "@/lib/integrations/microsoft/calendar-connect";
import {
  completeCalendarConnect,
  calendarConnection,
  patchCalendarMeta,
  _forgetCalendarAccessToken,
} from "@/lib/integrations/microsoft/calendar-token.server";
import { OUTLOOK_MAX_PAGES, OUTLOOK_PAGE_SIZE } from "./overlays";
import { loadOutlookOverlay, outlookOverlayStatus, OUTLOOK_THROTTLE_BUDGET_MS } from "./outlook.server";

// The Microsoft sign-in app, without the shared global row (and its vault key)
// that another test file may be writing at the same time.
vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () => ({ enabled: true, clientId: "client-id", clientSecret: "client-secret", tenant: null }),
}));

const TENANT = "11111111-2222-3333-4444-555555555555";
const jwt = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;
const stamp = Math.random().toString(36).slice(2, 8);

const WINDOW = { from: new Date("2027-03-01T00:00:00.000Z"), to: new Date("2027-04-12T00:00:00.000Z") };

const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
let orgId = "", offOrgId = "";
const user: Record<"viewer" | "colleague" | "unlinked" | "lapsed" | "renewing", string> = {
  viewer: "", colleague: "", unlinked: "", lapsed: "", renewing: "",
};
const g = fakeGraph();
const deps = { fetch: g.fetch, sleep: g.sleep };
const token = (who: keyof typeof user) => `Bearer at-${user[who]}`;
let viewerMain = "", colleagueMain = "", viewerCosmos = "";

/** Connect `userId` in `org` as a Microsoft account, as the sync specs do. */
async function connect(org: string, userId: string) {
  const fetchFn = (async (url: unknown) =>
    String(url).includes("/me?")
      ? new Response(JSON.stringify({ mail: null, userPrincipalName: `${userId}@example.test` }), { status: 200 })
      : new Response(
          JSON.stringify({ access_token: `at-${userId}`, refresh_token: "rt", expires_in: 3600, id_token: jwt({ tid: TENANT, oid: `oid-${userId}`, preferred_username: `${userId}@example.test` }) }),
          { status: 200 },
        )) as unknown as typeof fetch;
  await completeCalendarConnect(
    { orgId: org, userId, code: "c", verifier: "v", redirectUri: "https://x/cb", origin: "https://cosmos.example" },
    { fetch: fetchFn },
  );
}

beforeAll(async () => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
  orgId = (await prisma.organization.create({ data: { name: `outlook ${stamp}`, slug: `outlook-${stamp}` } })).id;
  offOrgId = (await prisma.organization.create({ data: { name: `outlook off ${stamp}`, slug: `outlook-off-${stamp}` } })).id;
  for (const who of Object.keys(user) as (keyof typeof user)[]) {
    user[who] = (await prisma.user.create({ data: { email: `${who}-${stamp}@outlook.test`, displayName: `${who} ${stamp}` } })).id;
    await prisma.orgMember.create({ data: { orgId, userId: user[who], role: "MEMBER" } });
  }
  await prisma.orgMember.create({ data: { orgId: offOrgId, userId: user.viewer, role: "MEMBER" } });
  await prisma.integration.create({
    data: { orgId, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId: TENANT }, status: "ACTIVE", installedById: user.viewer },
  });
  for (const who of ["viewer", "colleague", "lapsed", "renewing"] as const) await connect(orgId, user[who]);
  const lapsed = await calendarConnection(orgId, user.lapsed);
  await patchCalendarMeta(lapsed!.id, { status: "reconnect" });

  viewerMain = g.addCalendar({ name: "Calendar", owner: token("viewer"), isDefault: true });
  viewerCosmos = g.addCalendar({ name: "Cosmos", owner: token("viewer") });
  colleagueMain = g.addCalendar({ name: "Calendar", owner: token("colleague"), isDefault: true });
  g.addEventAt(viewerMain, `viewer-standup-${stamp}`, "2027-03-03T14:30:00.0000000", "2027-03-03T15:00:00.0000000", { webLink: "https://outlook.example/item/1" });
  g.addEventAt(viewerCosmos, `viewer-cosmos-copy-${stamp}`, "2027-03-03T16:00:00.0000000", "2027-03-03T17:00:00.0000000");
  g.addEventAt(viewerMain, `viewer-before-${stamp}`, "2027-02-27T10:00:00.0000000", "2027-03-01T00:00:00.0000000");
  g.addEventAt(viewerMain, `viewer-cancelled-${stamp}`, "2027-03-04T10:00:00.0000000", "2027-03-04T11:00:00.0000000", { isCancelled: true });
  g.addEventAt(viewerMain, `viewer-offsite-${stamp}`, "2027-03-10T00:00:00.0000000", "2027-03-12T00:00:00.0000000", { isAllDay: true });
  g.addEventAt(viewerMain, `viewer-badlink-${stamp}`, "2027-03-05T09:00:00.0000000", "2027-03-05T09:30:00.0000000", { webLink: "javascript:alert(1)" });
  g.addEventAt(colleagueMain, `colleague-review-${stamp}`, "2027-03-03T14:30:00.0000000", "2027-03-03T15:00:00.0000000");
  // What a full Graph event carries beyond the drawn fields. The fake sends
  // every field whatever `$select` asks, so this reaches the overlay's mapping.
  g.addEventAt(viewerMain, `viewer-briefing-${stamp}`, "2027-03-08T09:00:00.0000000", "2027-03-08T10:00:00.0000000", {
    webLink: "https://outlook.example/item/2",
    body: { contentType: "html", content: "<p>Agenda: budget figures</p>" },
    attendees: [{ type: "required", emailAddress: { name: "A colleague", address: "colleague@example.test" } }],
  } as Partial<FakeEvent>);
  const renewingMain = g.addCalendar({ name: "Calendar", owner: token("renewing"), isDefault: true });
  g.addEventAt(renewingMain, `renewing-planning-${stamp}`, "2027-03-09T09:00:00.0000000", "2027-03-09T10:00:00.0000000");
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, offOrgId] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(user) } } }).catch(() => undefined);
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

const subjects = async (who: keyof typeof user) =>
  (await loadOutlookOverlay(orgId, user[who], WINDOW, deps)).events.map((e) => e.subject);

describe("the Outlook overlay is only ever the viewer's own calendar", () => {
  it("the viewer gets their own events and none of a colleague's", async () => {
    const mine = await subjects("viewer");
    expect(mine).toContain(`viewer-standup-${stamp}`);
    expect(mine).not.toContain(`colleague-review-${stamp}`);
  });

  it("control: the colleague, asking for themselves, gets theirs and none of the viewer's", async () => {
    const theirs = await subjects("colleague");
    expect(theirs).toContain(`colleague-review-${stamp}`);
    expect(theirs).not.toContain(`viewer-standup-${stamp}`);
  });

  it("asks Graph for /me/calendarView and nothing else: no read names a mailbox", async () => {
    const before = g.calls.length;
    await loadOutlookOverlay(orgId, user.viewer, WINDOW, deps);
    const made = g.calls.slice(before);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((c) => c.method === "GET" && c.path.startsWith("/me/calendarView?"))).toBe(true);
  });

  it("reads the main calendar, not the Cosmos calendar Cosmos writes to", async () => {
    const mine = await subjects("viewer");
    expect(mine).not.toContain(`viewer-cosmos-copy-${stamp}`);
    expect(mine).toContain(`viewer-standup-${stamp}`);
  });
});

describe("when there is nothing to read, the status says why, and Microsoft is not called", () => {
  it("a member who has not connected is not_connected; the connected viewer is connected", async () => {
    const before = g.calls.length;
    const p = await loadOutlookOverlay(orgId, user.unlinked, WINDOW, deps);
    expect(p).toEqual({ status: "not_connected", events: [], capped: false });
    expect(g.calls.length).toBe(before);
    expect(await outlookOverlayStatus(orgId, user.viewer)).toBe("connected");
  });

  it("a connection Microsoft stopped accepting is reconnect", async () => {
    const before = g.calls.length;
    expect((await loadOutlookOverlay(orgId, user.lapsed, WINDOW, deps)).status).toBe("reconnect");
    expect(await outlookOverlayStatus(orgId, user.lapsed)).toBe("reconnect");
    expect(g.calls.length).toBe(before);
  });

  it("an organization without Outlook Calendar turned on is off, for the same person", async () => {
    expect(await outlookOverlayStatus(offOrgId, user.viewer)).toBe("off");
    expect((await loadOutlookOverlay(offOrgId, user.viewer, WINDOW, deps)).status).toBe("off");
    // Control: the same person, in the org that has it on.
    expect(await outlookOverlayStatus(orgId, user.viewer)).toBe("connected");
  });
});

describe("what the window holds", () => {
  it("asks Graph for exactly the window, and maps times, all-day dates and links", async () => {
    const before = g.calls.length;
    const p = await loadOutlookOverlay(orgId, user.viewer, WINDOW, deps);
    const q = new URLSearchParams(g.calls[before].path.split("?")[1]);
    expect(q.get("startDateTime")).toBe(WINDOW.from.toISOString());
    expect(q.get("endDateTime")).toBe(WINDOW.to.toISOString());
    expect(q.get("$top")).toBe(String(OUTLOOK_PAGE_SIZE));

    const by = Object.fromEntries(p.events.map((e) => [e.subject, e]));
    expect(by[`viewer-standup-${stamp}`]).toMatchObject({
      start: "2027-03-03T14:30:00.000Z", end: "2027-03-03T15:00:00.000Z", allDay: false, webLink: "https://outlook.example/item/1",
    });
    expect(by[`viewer-offsite-${stamp}`]).toMatchObject({
      start: "2027-03-10T00:00:00.000Z", end: "2027-03-12T00:00:00.000Z", allDay: true,
    });
    // Ends exactly where the window starts: not in it.
    expect(by).not.toHaveProperty(`viewer-before-${stamp}`);
    // A cancelled meeting is left off.
    expect(by).not.toHaveProperty(`viewer-cancelled-${stamp}`);
    // A link that is not https is dropped, and the event kept.
    expect(by[`viewer-badlink-${stamp}`]?.webLink).toBeNull();
    expect(p).toMatchObject({ status: "connected", capped: false });
  });

  it("follows Graph's next-page links, and says when it stopped short", async () => {
    const h = fakeGraph();
    const main = h.addCalendar({ name: "Calendar", owner: token("viewer"), isDefault: true });
    const many = OUTLOOK_PAGE_SIZE * 2 + 50;
    for (let i = 0; i < many; i++) {
      h.addEventAt(main, `e${i}`, `2027-03-02T${String(8 + (i % 10)).padStart(2, "0")}:00:00.0000000`, `2027-03-02T${String(9 + (i % 10)).padStart(2, "0")}:00:00.0000000`);
    }
    const all = await loadOutlookOverlay(orgId, user.viewer, WINDOW, { fetch: h.fetch, sleep: h.sleep });
    expect(all.events).toHaveLength(many);
    expect(all.capped).toBe(false);
    expect(h.calls).toHaveLength(3);

    const cap = OUTLOOK_PAGE_SIZE * OUTLOOK_MAX_PAGES;
    for (let i = many; i < cap + 20; i++) h.addEventAt(main, `e${i}`, "2027-03-20T08:00:00.0000000", "2027-03-20T09:00:00.0000000");
    const capped = await loadOutlookOverlay(orgId, user.viewer, WINDOW, { fetch: h.fetch, sleep: h.sleep });
    expect(capped.events).toHaveLength(cap);
    expect(capped.capped).toBe(true);
  });
});

describe("what reaches the browser", () => {
  it("each event is exactly the six drawn fields, though Graph sent a body and attendees", async () => {
    // Positive control: the Graph read itself does carry them.
    const q = new URLSearchParams({ startDateTime: WINDOW.from.toISOString(), endDateTime: WINDOW.to.toISOString() });
    const res = await g.fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${q}`, { headers: { Authorization: token("viewer") } });
    const raw = ((await res.json()) as { value: Record<string, unknown>[] }).value.find((e) => e.subject === `viewer-briefing-${stamp}`);
    expect(raw).toHaveProperty("body.content", "<p>Agenda: budget figures</p>");
    expect(raw?.attendees).toHaveLength(1);

    const p = await loadOutlookOverlay(orgId, user.viewer, WINDOW, deps);
    expect(Object.keys(p).sort()).toEqual(["capped", "events", "status"]);
    expect(p.events.find((e) => e.subject === `viewer-briefing-${stamp}`)).toEqual({
      id: raw?.id,
      subject: `viewer-briefing-${stamp}`,
      start: "2027-03-08T09:00:00.000Z",
      end: "2027-03-08T10:00:00.000Z",
      allDay: false,
      webLink: "https://outlook.example/item/2",
    });
    for (const e of p.events) expect(Object.keys(e).sort()).toEqual(["allDay", "end", "id", "start", "subject", "webLink"]);
    expect(JSON.stringify(p)).not.toMatch(/Agenda|colleague@/);
  });
});

const GRAPH = "https://graph.microsoft.com/";
const isToken = (url: string) => url.includes("/oauth2/v2.0/token");

/**
 * `base`, except that the `n`th Graph call (from 0) gets what `answer` gives,
 * when it gives anything; `token` answers the sign-in service, when given.
 */
function wrap(
  base: typeof fetch,
  answer: (n: number) => Promise<Response> | undefined,
  token?: () => Promise<Response>,
): typeof fetch {
  let n = 0;
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (token && isToken(url)) return token();
    if (url.startsWith(GRAPH)) {
      const r = answer(n++);
      if (r) return r;
    }
    return base(url, init);
  }) as typeof fetch;
}
const throttled = (retryAfter: string) =>
  Promise.resolve(new Response(JSON.stringify({ error: { code: "TooManyRequests" } }), { status: 429, headers: { "Retry-After": retryAfter } }));

describe("whatever goes wrong reaching Microsoft, the page gets unavailable, not an error", () => {
  const cases: [string, () => Promise<Response>, RegExp, string][] = [
    ["a timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), /did not answer in time/, "TimeoutError"],
    ["a dropped connection", () => Promise.reject(new TypeError("fetch failed")), /went wrong reaching Microsoft/, "TypeError"],
    ["a body that is not JSON", () => Promise.resolve(new Response("<html>Bad gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } })), /went wrong reaching Microsoft/, "SyntaxError"],
  ];
  it.each(cases)("%s", async (_name, fail, detail, logged) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const p = await loadOutlookOverlay(orgId, user.viewer, WINDOW, { fetch: wrap(g.fetch, () => fail()), sleep: g.sleep });
      expect(p).toEqual({ status: "unavailable", events: [], capped: false, detail: expect.stringMatching(detail) });
      // Logged by the error's name only. A JSON parse error's message quotes
      // the body Microsoft sent.
      expect(warn.mock.calls).toEqual([["outlook overlay read failed:", logged]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("<html>");
    } finally {
      warn.mockRestore();
    }
    // Control: the same read, Microsoft answering, is connected.
    expect((await loadOutlookOverlay(orgId, user.viewer, WINDOW, deps)).status).toBe("connected");
  });

  it("the sign-in service failing to renew the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    _forgetCalendarAccessToken(orgId, user.renewing);
    try {
      const down = () => Promise.resolve(new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 }));
      const p = await loadOutlookOverlay(orgId, user.renewing, WINDOW, { fetch: wrap(g.fetch, () => undefined, down), sleep: g.sleep });
      expect(p).toMatchObject({ status: "unavailable", events: [] });
    } finally {
      warn.mockRestore();
    }
    // A passing outage is not a revoked connection: no reconnect asked for.
    expect(await outlookOverlayStatus(orgId, user.renewing)).toBe("connected");
    // Control: the sign-in service answering, the same read gets the events.
    const up = () => Promise.resolve(new Response(JSON.stringify({ access_token: `at-${user.renewing}`, expires_in: 3600 }), { status: 200 }));
    const ok = await loadOutlookOverlay(orgId, user.renewing, WINDOW, { fetch: wrap(g.fetch, () => undefined, up), sleep: g.sleep });
    expect(ok.status).toBe("connected");
    expect(ok.events.map((e) => e.subject)).toContain(`renewing-planning-${stamp}`);
  });
});

describe("waiting on Microsoft's throttling has one budget per read", () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it(`two waits that overrun ${OUTLOOK_THROTTLE_BUDGET_MS / 1000} s: the second is not started, and the read says throttled`, async () => {
    const waits: number[] = [];
    const f = wrap(g.fetch, (n) => (n < 2 ? throttled("6") : undefined));
    const p = await loadOutlookOverlay(orgId, user.viewer, WINDOW, { fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect(p.status).toBe("unavailable");
    expect(p.detail).toMatch(/limiting requests/);
    expect(waits).toEqual([6_000]);
  });

  it("control: waits that fit are waited, and the read goes on", async () => {
    const waits: number[] = [];
    const f = wrap(g.fetch, (n) => (n < 2 ? throttled("4") : undefined));
    const p = await loadOutlookOverlay(orgId, user.viewer, WINDOW, { fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect(p.status).toBe("connected");
    expect(waits).toEqual([4_000, 4_000]);
  });

  it("the budget spans the pages: a wait on page two counts what page one waited", async () => {
    const h = fakeGraph();
    const main = h.addCalendar({ name: "Calendar", owner: token("viewer"), isDefault: true });
    for (let i = 0; i < OUTLOOK_PAGE_SIZE + 10; i++) h.addEventAt(main, `p${i}`, "2027-03-02T08:00:00.0000000", "2027-03-02T09:00:00.0000000");
    // Graph calls: page one throttled, page one, page two throttled, page two.
    const waits: number[] = [];
    const f = wrap(h.fetch, (n) => (n === 0 || n === 2 ? throttled("6") : undefined));
    const p = await loadOutlookOverlay(orgId, user.viewer, WINDOW, { fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect(p.status).toBe("unavailable");
    expect(sum(waits)).toBeLessThanOrEqual(OUTLOOK_THROTTLE_BUDGET_MS);
    expect(waits).toEqual([6_000]);

    // Control: page two throttled alone is waited out, and both pages arrive.
    const again: number[] = [];
    const g2 = wrap(h.fetch, (n) => (n === 1 ? throttled("6") : undefined));
    const ok = await loadOutlookOverlay(orgId, user.viewer, WINDOW, { fetch: g2, sleep: async (ms) => void again.push(ms) });
    expect(ok.status).toBe("connected");
    expect(ok.events).toHaveLength(OUTLOOK_PAGE_SIZE + 10);
    expect(again).toEqual([6_000]);
  });
});

describe("when Microsoft does not answer usefully", () => {
  it("throttled past the retries: unavailable, saying so in words; then connected again", async () => {
    g.throttleNext(3, "1");
    const p = await loadOutlookOverlay(orgId, user.viewer, WINDOW, deps);
    expect(p.status).toBe("unavailable");
    expect(p.detail).toMatch(/limiting requests/);
    expect(p.events).toEqual([]);
    // Control: once Microsoft answers, the same read works.
    expect((await loadOutlookOverlay(orgId, user.viewer, WINDOW, deps)).status).toBe("connected");
  });

  it("an error from Graph is unavailable with its status, never thrown at the page", async () => {
    const h = fakeGraph(); // no main calendar for anyone: Graph answers 404
    const p = await loadOutlookOverlay(orgId, user.viewer, WINDOW, { fetch: h.fetch, sleep: h.sleep });
    expect(p.status).toBe("unavailable");
    expect(p.detail).toContain("404");
  });
});
