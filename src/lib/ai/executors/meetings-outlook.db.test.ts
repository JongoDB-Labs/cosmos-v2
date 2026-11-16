// @vitest-environment node
//
// Cosmo's create_meeting, all the way to Outlook (e2e DB, in-memory Graph).
// A meeting lands in the Outlook of its attendees who have connected it, and
// a Teams meeting in its host's: the same people a meeting made in the app
// reaches. One with nobody on it writes nothing, in the app or here.
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db/client";

// Per-person Teams and invitation limits are in-process buckets: let them through.
vi.mock("@/lib/rate-limit/bucket", async (orig) => {
  const actual = await orig<typeof import("@/lib/rate-limit/bucket")>();
  return { ...actual, rateLimit: () => ({ allowed: true as const, remaining: 99 }) };
});
vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () => ({ enabled: true, clientId: "client-id", clientSecret: "client-secret", tenant: null }),
}));
// The push runs for real, against the in-memory Graph instead of Microsoft:
// these tests read what landed in Outlook, not whether a push was asked for.
const graph = vi.hoisted(() => ({
  deps: null as null | { fetch: typeof fetch; sleep: (ms: number) => Promise<void> },
  runs: [] as Promise<unknown>[],
}));
vi.mock("@/lib/integrations/microsoft/calendar-sync.server", async (orig) => {
  const actual = await orig<typeof import("@/lib/integrations/microsoft/calendar-sync.server")>();
  return {
    ...actual,
    syncMeetingSoon: (orgId: string, meetingId: string) => void graph.runs.push(actual.syncMeeting(orgId, meetingId, graph.deps!)),
  };
});

import { fakeGraph } from "@/lib/testing/fake-graph";
import { MS_CALENDAR } from "@/lib/integrations/microsoft/calendar-connect";
import { _resetCalendarTokenCache, completeCalendarConnect } from "@/lib/integrations/microsoft/calendar-token.server";
import { TEAMS_REFUSED } from "@/lib/meetings/teams-messages";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import { createMeeting } from "./meetings";

const TENANT = "11111111-2222-3333-4444-555555555555";
const jwt = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** An hour from now: inside every window the sync uses. */
const START = new Date(Math.floor((Date.now() + 60 * 60 * 1000) / 1000) * 1000).toISOString();
const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;

type Person = { id: string; email: string };
let orgId = "", otherOrgId = "";
let alice: Person, bob: Person, carol: Person, stranger: Person;
let g: ReturnType<typeof fakeGraph>;

async function person(name: string): Promise<Person> {
  const email = `${name}-${stamp}@mout.test`;
  return { id: (await prisma.user.create({ data: { email, displayName: name } })).id, email };
}
async function connect(u: Person) {
  const fetchFn = (async (url: unknown) =>
    String(url).includes("/me?")
      ? new Response(JSON.stringify({ mail: null, userPrincipalName: u.email }), { status: 200 })
      : new Response(
          JSON.stringify({ access_token: `at-${u.id}`, refresh_token: "rt", expires_in: 3600, id_token: jwt({ tid: TENANT, oid: `oid-${u.id}`, preferred_username: u.email }) }),
          { status: 200 },
        )) as unknown as typeof fetch;
  await completeCalendarConnect(
    { orgId, userId: u.id, code: "c", verifier: "v", redirectUri: "https://x/cb", origin: "https://cosmos.example" },
    { fetch: fetchFn },
  );
}

beforeAll(async () => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
  _resetCalendarTokenCache();
  [alice, bob, carol, stranger] = [await person("alice"), await person("bob"), await person("carol"), await person("stranger")];
  orgId = (await prisma.organization.create({ data: { name: `mout ${stamp}`, slug: `mout-${stamp}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `mout2 ${stamp}`, slug: `mout2-${stamp}` } })).id;
  await prisma.orgMember.createMany({
    data: [
      { orgId, userId: alice.id, role: "ADMIN" },
      { orgId, userId: bob.id, role: "MEMBER" },
      { orgId, userId: carol.id, role: "MEMBER" },
      { orgId: otherOrgId, userId: stranger.id, role: "MEMBER" },
    ],
  });
  await prisma.integration.create({
    data: { orgId, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId: TENANT }, status: "ACTIVE", installedById: alice.id },
  });
  await connect(alice);
  await connect(bob); // carol never connects
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${stamp}@mout.test` } } }).catch(() => undefined);
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

beforeEach(() => {
  g = fakeGraph();
  for (const u of [alice, bob]) g.setAddress(`Bearer at-${u.id}`, u.email);
  graph.deps = { fetch: g.fetch, sleep: g.sleep };
  graph.runs.splice(0);
});

type Made = { created?: boolean; id?: string; error?: string };
const make = async (by: Person, input: Record<string, unknown>) =>
  (await createMeeting({ meetingDate: START, ...input }, await memberToolCtx(orgId, by.id))) as Made;
const writes = () => g.calls.filter((c) => c.method !== "GET");
const linkedTo = async (meetingId: string) =>
  (await prisma.externalEventLink.findMany({ where: { orgId, entityId: meetingId }, select: { userId: true } })).map((l) => l.userId);
const saved = (title: string) => prisma.syncMeeting.count({ where: { orgId, title } });

describe("a meeting Cosmo creates reaches Outlook (e2e DB, in-memory Graph)", () => {
  it("lands in an attendee's Outlook when they've connected it: one event, one link", async () => {
    const res = await make(alice, { title: `with bob ${stamp}`, attendeeIds: [bob.id] });
    expect(res.created).toBe(true);
    await Promise.all(graph.runs);
    expect(graph.runs).toHaveLength(1);
    expect([...g.events.values()].map((e) => e.subject)).toEqual([`with bob ${stamp}`]);
    expect(await linkedTo(res.id!)).toEqual([bob.id]);
    const row = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: res.id! }, include: { attendees: true } });
    expect(row.attendees.map((a) => a.userId)).toEqual([bob.id]);
  });

  it("with nobody on it, writes nothing to anyone's Outlook, as in the app (the creator isn't added)", async () => {
    const res = await make(alice, { title: `nobody ${stamp}` });
    expect(res.created).toBe(true);
    await Promise.all(graph.runs);
    expect(graph.runs).toHaveLength(1); // the push ran: what it wrote is what's measured
    expect(writes()).toEqual([]);
    expect(await linkedTo(res.id!)).toEqual([]);
  });

  it("refuses an attendee from outside the organization, saving and pushing nothing", async () => {
    const res = await make(alice, { title: `stranger ${stamp}`, attendeeIds: [bob.id, stranger.id] });
    expect(res.error).toBe("Attendees must be members of this organization.");
    expect(await saved(`stranger ${stamp}`)).toBe(0);
    expect(graph.runs).toHaveLength(0);
  });

  it("makes a Teams meeting in the requester's own Outlook, with a join link", async () => {
    const res = await make(alice, { title: `teams ${stamp}`, teamsMeeting: true });
    expect(res.created).toBe(true);
    await Promise.all(graph.runs);
    const row = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: res.id! } });
    expect(row.teamsHostId).toBe(alice.id);
    expect(row.teamsJoinUrl).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/meetup-join\/fake-/);
    expect(await linkedTo(res.id!)).toEqual([alice.id]);
    expect([...g.events.values()].map((e) => e.isOnlineMeeting)).toEqual([true]);
  });

  it("refuses a Teams meeting when the requester's Outlook isn't connected, saving nothing", async () => {
    const res = await make(carol, { title: `teams carol ${stamp}`, teamsMeeting: true });
    expect(res.error).toBe(TEAMS_REFUSED.not_connected[1]);
    expect(await saved(`teams carol ${stamp}`)).toBe(0);
    expect(graph.runs).toHaveLength(0);
  });

  it("never makes a Teams meeting on an API key", async () => {
    const ctx = await memberToolCtx(orgId, alice.id);
    const res = (await createMeeting(
      { title: `teams key ${stamp}`, meetingDate: START, teamsMeeting: true },
      { ...ctx, auth: { ...ctx.auth, isApiKey: true } },
    )) as Made;
    expect(res.error).toMatch(/API key/);
    expect(await saved(`teams key ${stamp}`)).toBe(0);
  });
});
