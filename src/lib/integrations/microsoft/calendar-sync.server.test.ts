// COSMOS-202 (B2, e2e DB): Cosmos meetings mirrored into each attendee's
// Outlook "Cosmos" calendar, and Outlook edits brought back. Against an
// in-memory Graph: echoes of our own writes are skipped; an edit by someone
// who can't edit the meeting is ignored, audit-logged and overwritten; a
// classified meeting is a bare busy block going out and only its time comes
// back; Retry-After is honoured.
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db/client";

// Per-person invitation limits are in-process buckets keyed by user, and every
// test here is alice: let them through, except in the test about the limits.
// `denyOps` plays an organizer whose invitation budget is spent.
const rl = vi.hoisted(() => ({ real: false, denyOps: false }));
vi.mock("@/lib/rate-limit/bucket", async (orig) => {
  const actual = await orig<typeof import("@/lib/rate-limit/bucket")>();
  return {
    ...actual,
    rateLimit: (k: string, o: Parameters<typeof actual.rateLimit>[1]) =>
      rl.denyOps && k.startsWith("ms.invite.ops:") ? { allowed: false as const, retryAfter: 60 }
      : rl.real ? actual.rateLimit(k, o) : { allowed: true as const, remaining: 99 },
  };
});
import { fakeGraph } from "@/lib/testing/fake-graph";
import { MS_CALENDAR } from "./calendar-connect";
import { _resetCalendarTokenCache, completeCalendarConnect, disconnectCalendar } from "./calendar-token.server";
import {
  InviteRefused, ensureCosmosCalendar, invitePreview, liveInvites, offboardInvites, pool, pullChanges, pullSoonIfStale,
  MAX_INVITEES, releaseInvitesOnDisconnect, removeCosmosCalendar, runCalendarPulls, setMeetingInvite, syncInvitesAfterClassification,
  syncMeeting, syncUserNow,
} from "./calendar-sync.server";
import { patchCalendarMeta } from "./calendar-token.server";

// The Microsoft sign-in app, without the shared global row (and its vault key)
// that another test file may be writing at the same time.
vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () => ({ enabled: true, clientId: "client-id", clientSecret: "client-secret", tenant: null }),
}));

const TENANT = "11111111-2222-3333-4444-555555555555";
const jwt = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;

const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
beforeAll(() => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
});
afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

const START = new Date("2026-11-02T15:00:00.000Z");
const at = (d: Date) => ({ dateTime: d.toISOString().slice(0, 23) + "0000", timeZone: "UTC" });

describe("Outlook meeting sync (e2e DB)", () => {
  const orgIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  });
  beforeEach(() => _resetCalendarTokenCache());

  /** Connect `u` in `orgId` as Microsoft account `oid` (its mailbox is its user id). */
  async function connect(orgId: string, u: { id: string; email: string }, oid: string, mail?: string) {
    const fetchFn = (async (url: unknown) =>
      String(url).includes("/me?")
        ? new Response(JSON.stringify({ mail: mail ?? null, userPrincipalName: u.email }), { status: 200 })
        : new Response(
            JSON.stringify({ access_token: `at-${u.id}`, refresh_token: "rt", expires_in: 3600, id_token: jwt({ tid: TENANT, oid, preferred_username: u.email }) }),
            { status: 200 },
          )) as unknown as typeof fetch;
    await completeCalendarConnect(
      { orgId, userId: u.id, code: "c", verifier: "v", redirectUri: "https://x/cb", origin: "https://cosmos.example" },
      { fetch: fetchFn },
    );
  }

  /** alice can edit meetings (ADMIN); bob can only see them (VIEWER). Both connected. */
  async function setup() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
    const org = await prisma.organization.create({ data: { name: `mss ${stamp}`, slug: `mss-${stamp}` } });
    orgIds.push(org.id);
    await prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: alice.id, role: "ADMIN" },
        { orgId: org.id, userId: bob.id, role: "VIEWER" },
      ],
    });
    await prisma.integration.create({
      data: { orgId: org.id, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId: TENANT }, status: "ACTIVE", installedById: alice.id },
    });
    for (const u of [alice, bob]) await connect(org.id, u, `${u.id}-${stamp}`);
    const g = fakeGraph();
    for (const u of [alice, bob]) g.setAddress(`Bearer at-${u.id}`, u.email);
    const deps = { fetch: g.fetch, sleep: g.sleep };
    const meeting = await prisma.syncMeeting.create({
      data: {
        orgId: org.id, title: "Sprint review", meetingDate: START, durationMinutes: 45, createdById: alice.id, notes: "",
        meetingUrl: "https://meet.example/abc",
        attendees: { create: [{ userId: alice.id }, { userId: bob.id }] },
      },
    });
    return { org, alice, bob, g, deps, meeting, stamp };
  }

  const linkOf = (userId: string, meetingId: string) =>
    prisma.externalEventLink.findFirst({ where: { provider: MS_CALENDAR, userId, entityType: "meeting", entityId: meetingId } });

  it("puts a meeting in each connected attendee's own Cosmos calendar, with a link back", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.calendars.size).toBe(2);
    expect([...g.calendars.values()].every((c) => c.name === "Cosmos")).toBe(true);
    for (const u of [alice, bob]) {
      const link = await linkOf(u.id, meeting.id);
      expect(link).toBeTruthy();
      const ev = g.events.get(link!.externalEventId)!;
      expect(ev.subject).toBe("Sprint review");
      expect(ev.start.dateTime).toBe("2026-11-02T15:00:00.000");
      expect(ev.end.dateTime).toBe("2026-11-02T15:45:00.000");
      expect(ev.body?.content).toContain(`https://cosmos.example/${org.slug}/meetings/${meeting.id}`);
      expect(ev.transactionId).toMatch(new RegExp(`^cosmos-${meeting.id}-${u.id}-`));
      expect(link!.changeKey).toBe(ev.changeKey);
    }
    // A second push updates in place; it never duplicates.
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Sprint review (moved)" } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.eventsIn([...g.calendars.keys()][0])).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  });

  it("skips its own writes coming back through the delta (changeKey echo)", async () => {
    const { org, alice, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const before = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } });
    const r = await pullChanges(org.id, alice.id, deps);
    expect(r).toMatchObject({ echoes: 1, applied: 0, ignored: 0 });
    const after = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await prisma.activity.count({ where: { subjectId: meeting.id } })).toBe(0);
    // And the next pull is incremental: nothing new.
    expect(await pullChanges(org.id, alice.id, deps)).toMatchObject({ echoes: 0, applied: 0 });
  });

  it("brings back a move made in Outlook by someone who may edit, and moves everyone else's copy", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const aLink = (await linkOf(alice.id, meeting.id))!;
    const moved = new Date("2026-11-03T09:00:00.000Z");
    await new Promise((r) => setTimeout(r, 5));
    g.outlookEdit(aLink.externalEventId, { start: at(moved), end: at(new Date(moved.getTime() + 60 * 60_000)), subject: "Review" });
    const callsBefore = g.calls.length;
    const r = await pullChanges(org.id, alice.id, deps);
    expect(r).toMatchObject({ applied: 1, ignored: 0 });
    // Her own copy is the source: it is not written back over.
    expect(g.calls.slice(callsBefore).filter((c) => c.path.includes(aLink.externalEventId))).toEqual([]);
    const m = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(m.meetingDate).toEqual(moved);
    expect(m.durationMinutes).toBe(60);
    expect(m.title).toBe("Review");
    const acts = await prisma.activity.findMany({ where: { subjectId: meeting.id, action: "outlook_updated" } });
    expect(acts.map((a) => a.field).sort()).toEqual(["durationMinutes", "meetingDate", "title"]);
    const bEv = g.events.get((await linkOf(bob.id, meeting.id))!.externalEventId)!;
    expect(bEv.start.dateTime).toBe("2026-11-03T09:00:00.000");
    expect(bEv.subject).toBe("Review");
    // Alice's own copy was not pushed back over her edit, and her next pull is quiet.
    expect(await pullChanges(org.id, alice.id, deps)).toMatchObject({ applied: 0, ignored: 0 });
  });

  it("ignores an Outlook edit by someone without edit rights, logs it, and puts the Cosmos version back", async () => {
    const { org, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const bLink = (await linkOf(bob.id, meeting.id))!;
    await new Promise((r) => setTimeout(r, 5));
    g.outlookEdit(bLink.externalEventId, { start: at(new Date("2026-11-05T09:00:00.000Z")), subject: "Cancelled lol" });
    const r = await pullChanges(org.id, bob.id, deps);
    expect(r).toMatchObject({ applied: 0, ignored: 1 });
    const m = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(m.meetingDate).toEqual(START);
    expect(m.title).toBe("Sprint review");
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: "microsoft_calendar.writeback_ignored" } });
    expect(audit?.metadata).toMatchObject({ reason: "no_edit_rights" });
    const ev = g.events.get(bLink.externalEventId)!;
    expect(ev.start.dateTime).toBe("2026-11-02T15:00:00.000");
    expect(ev.subject).toBe("Sprint review");
    // The re-push is recognised as our own on the next pull, not a new edit.
    expect(await pullChanges(org.id, bob.id, deps)).toMatchObject({ ignored: 0, echoes: 1 });
  });

  it("keeps the Cosmos version when it changed after the Outlook edit", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const aLink = (await linkOf(alice.id, meeting.id))!;
    g.outlookEdit(aLink.externalEventId, { subject: "Outlook title" });
    await new Promise((r) => setTimeout(r, 5));
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Cosmos title" } });
    const r = await pullChanges(org.id, alice.id, deps);
    expect(r).toMatchObject({ applied: 0, ignored: 1 });
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).title).toBe("Cosmos title");
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: "microsoft_calendar.writeback_ignored" } });
    expect(audit?.metadata).toMatchObject({ reason: "cosmos_newer" });
    expect(g.events.get(aLink.externalEventId)!.subject).toBe("Cosmos title");
  });

  it("sends a classified meeting as a bare busy block, and only its time comes back", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await prisma.dataClassification.create({ data: { orgId: org.id, level: "FOUO", appliedById: alice.id } });
    await syncMeeting(org.id, meeting.id, deps);
    const aLink = (await linkOf(alice.id, meeting.id))!;
    const ev = g.events.get(aLink.externalEventId)!;
    expect(ev.subject).toBe("Cosmos item");
    expect(ev.body?.content).toBe("");
    expect(ev.showAs).toBe("busy");
    expect(JSON.stringify(g.calls)).not.toMatch(/Sprint review|meet\.example|\/meetings\//);
    await new Promise((r) => setTimeout(r, 5));
    const moved = new Date("2026-11-04T10:00:00.000Z");
    g.outlookEdit(aLink.externalEventId, { start: at(moved), end: at(new Date(moved.getTime() + 45 * 60_000)), subject: "My guess at the title" });
    expect(await pullChanges(org.id, alice.id, deps)).toMatchObject({ applied: 1 });
    const m = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(m.meetingDate).toEqual(moved);
    expect(m.title).toBe("Sprint review");
    // Everything pushed after the change is still bare.
    expect(JSON.stringify(g.calls)).not.toMatch(/Sprint review|meet\.example/);
  });

  it("treats a marking in the meeting's own title as classified, with no org ceiling", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "CUI//SP-PRVCY roster review" } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.events.get((await linkOf(alice.id, meeting.id))!.externalEventId)!.subject).toBe("Cosmos item");
    expect(JSON.stringify(g.calls)).not.toMatch(/roster/);
  });

  it("detaches when deleted in Outlook, keeps the meeting, and removes copies when the meeting is cancelled", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    g.outlookDelete((await linkOf(alice.id, meeting.id))!.externalEventId);
    expect(await pullChanges(org.id, alice.id, deps)).toMatchObject({ detached: 1 });
    expect(await linkOf(alice.id, meeting.id)).toBeNull();
    expect(await prisma.syncMeeting.findUnique({ where: { id: meeting.id } })).toBeTruthy();
    const bEventId = (await linkOf(bob.id, meeting.id))!.externalEventId;
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { status: "CANCELLED" } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.events.get(bEventId)!.removed).toBe(true);
    expect(await prisma.externalEventLink.count({ where: { entityId: meeting.id } })).toBe(0);
  });

  it("removes the copy of someone taken off the meeting, and everyone's once it is deleted", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const bEventId = (await linkOf(bob.id, meeting.id))!.externalEventId;
    await prisma.meetingAttendee.deleteMany({ where: { meetingId: meeting.id, userId: bob.id } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.events.get(bEventId)!.removed).toBe(true);
    const aEventId = (await linkOf(alice.id, meeting.id))!.externalEventId;
    expect(g.events.get(aEventId)!.removed).toBeFalsy();
    await prisma.syncMeeting.delete({ where: { id: meeting.id } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.events.get(aEventId)!.removed).toBe(true);
  });

  it("honours Retry-After when Microsoft throttles, then gives up on that person only", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    g.throttleNext(2, "3");
    await syncMeeting(org.id, meeting.id, deps); // two 429s, then through
    expect(g.sleeps).toEqual([3000, 3000]);
    expect(await linkOf(alice.id, meeting.id)).toBeTruthy();
    expect(await linkOf(bob.id, meeting.id)).toBeTruthy();
    // A run where the first person stays throttled: they're skipped, the other still syncs.
    g.sleeps.length = 0;
    let first = true;
    const run = runCalendarPulls({
      ...deps,
      jitterMs: 1000,
      random: () => 0.25,
      sleep: async (ms) => {
        g.sleeps.push(ms);
        if (first && ms === 250) {
          first = false;
          g.throttleNext(3);
        }
      },
    });
    const r = await run;
    expect(r.throttled).toBe(1);
    expect(r.people).toBeGreaterThanOrEqual(1);
    expect(g.sleeps.filter((ms) => ms === 250).length).toBeGreaterThanOrEqual(2); // jitter before each person
  });

  it("pulls lazily when someone opens their meetings, but not again within two minutes", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const deltas = () => g.calls.filter((c) => c.path.includes("calendarView/delta")).length;
    const t = Date.now();
    await pullSoonIfStale(org.id, alice.id, t, deps); // never pulled: goes
    expect(deltas()).toBe(1);
    expect(pullSoonIfStale(org.id, alice.id, t + 60_000, deps)).toBeUndefined(); // too soon
    await pullSoonIfStale(org.id, alice.id, t + 3 * 60_000, deps); // stale again: goes
    expect(deltas()).toBe(2);
  });

  it("Sync now pulls before it pushes, so an Outlook edit or delete isn't overwritten", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncUserNow(org.id, alice.id, deps);
    const link = (await linkOf(alice.id, meeting.id))!;
    const moved = new Date("2026-11-06T08:00:00.000Z");
    await new Promise((r) => setTimeout(r, 5));
    g.outlookEdit(link.externalEventId, { start: at(moved), end: at(new Date(moved.getTime() + 45 * 60_000)) });
    expect(await syncUserNow(org.id, alice.id, deps)).toMatchObject({ applied: 1 });
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).meetingDate).toEqual(moved);
    // Her copy is the source: left as Outlook wrote it, not pushed back.
    expect(g.events.get(link.externalEventId)!.start.dateTime).toBe("2026-11-06T08:00:00.0000000");
    // Nothing unchanged is rewritten.
    const patches = () => g.calls.filter((c) => c.method === "PATCH").length;
    const before = patches();
    await syncUserNow(org.id, alice.id, deps);
    expect(patches()).toBe(before);
    // Deleted in Outlook: detached, and Sync now doesn't bring it back.
    g.outlookDelete(link.externalEventId);
    expect(await syncUserNow(org.id, alice.id, deps)).toMatchObject({ detached: 1 });
    expect(await linkOf(alice.id, meeting.id)).toBeNull();
    expect(g.eventsIn([...g.calendars.keys()][0])).toHaveLength(0);
    // ...until the meeting itself changes in Cosmos.
    await new Promise((r) => setTimeout(r, 5));
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Back on" } });
    await syncUserNow(org.id, alice.id, deps);
    expect(g.eventsIn([...g.calendars.keys()][0]).map((e) => e.subject)).toEqual(["Back on"]);
  });

  it("Sync now pushes the person's meetings and pulls; disconnecting removes the calendar and the links", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    const r = await syncUserNow(org.id, alice.id, deps);
    expect(r).toMatchObject({ applied: 0, ignored: 0 });
    expect(await linkOf(alice.id, meeting.id)).toBeTruthy();
    const conn = await prisma.connectorCredential.findFirstOrThrow({ where: { orgId: org.id, userId: alice.id, provider: MS_CALENDAR } });
    expect((conn.meta as { lastSyncAt?: string }).lastSyncAt).toBeTruthy();
    expect(await removeCosmosCalendar(org.id, alice.id, deps)).toBe(true);
    expect(g.calendars.size).toBe(0);
    await disconnectCalendar(org.id, alice.id);
    expect(await prisma.externalEventLink.count({ where: { orgId: org.id, userId: alice.id } })).toBe(0);
  });

  // ── Review fixes: who gets a copy ──────────────────────────────────────────

  const credOf = (orgId: string, userId: string) =>
    prisma.connectorCredential.findFirstOrThrow({ where: { orgId, provider: MS_CALENDAR, userId } });

  it("gives no copy to an attendee who can't see the meeting's project, and removes one when access goes", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const bEvent = (await linkOf(bob.id, meeting.id))!.externalEventId;
    const p = await prisma.project.create({
      data: { orgId: org.id, key: `T${Math.random().toString(36).slice(2, 7).toUpperCase()}`, name: "Team only", teamScopedAccess: true },
    });
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { projectId: p.id } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.events.get(bEvent)!.removed).toBe(true); // bob isn't on the team
    expect(await linkOf(bob.id, meeting.id)).toBeNull();
    expect(await linkOf(alice.id, meeting.id)).toBeTruthy(); // an admin still sees it
    // Nor does Sync now bring it back for him.
    await syncUserNow(org.id, bob.id, deps);
    expect(await linkOf(bob.id, meeting.id)).toBeNull();
  });

  it("never sends a meeting to someone without MEETING_READ, and removes their copy at the next pull once they lose it", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const bEvent = (await linkOf(bob.id, meeting.id))!.externalEventId;
    await prisma.orgMember.updateMany({ where: { orgId: org.id, userId: bob.id }, data: { role: "GUEST" } });
    await pullChanges(org.id, bob.id, deps); // the reconcile pass
    expect(g.events.get(bEvent)!.removed).toBe(true);
    const other = await prisma.syncMeeting.create({
      data: { orgId: org.id, title: "Board prep", meetingDate: START, createdById: alice.id, notes: "", attendees: { create: [{ userId: alice.id }, { userId: bob.id }] } },
    });
    await syncMeeting(org.id, other.id, deps);
    expect(await linkOf(bob.id, other.id)).toBeNull();
    expect(JSON.stringify(g.calls.filter((c) => c.body).map((c) => c.body))).toContain("Board prep"); // alice got it
    expect(g.eventsIn(((await credOf(org.id, bob.id)).meta as { calendarId: string }).calendarId)).toHaveLength(0);
  });

  // ── Review fixes: the Cosmos calendar survives reconnects ──────────────────

  const calendarPosts = (g: ReturnType<typeof fakeGraph>) => g.calls.filter((c) => c.method === "POST" && c.path === "/me/calendars").length;

  it("a reconnect with the same account keeps the calendar and delta; nothing is created twice", async () => {
    const { org, alice, g, deps, meeting, stamp } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    await pullChanges(org.id, alice.id, deps);
    const before = (await credOf(org.id, alice.id)).meta as { calendarId: string; deltaLink: string };
    await connect(org.id, alice, `${alice.id}-${stamp}`);
    const after = (await credOf(org.id, alice.id)).meta as { calendarId: string; deltaLink: string; status: string };
    expect(after).toMatchObject({ calendarId: before.calendarId, deltaLink: before.deltaLink, status: "connected" });
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Renamed" } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(calendarPosts(g)).toBe(2); // alice's and bob's, once each
    expect(await linkOf(alice.id, meeting.id)).toBeTruthy();
  });

  it("finds an existing Cosmos calendar by name instead of creating a second one", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const { id, meta } = await credOf(org.id, alice.id);
    const calendarId = (meta as { calendarId: string }).calendarId;
    await patchCalendarMeta(id, {}, ["calendarId"]); // as if the record were lost
    expect(await ensureCosmosCalendar(org.id, alice.id, deps)).toBe(calendarId);
    expect(calendarPosts(g)).toBe(2);
  });

  it("creates one calendar for two concurrent callers, and recovers from Graph's 409 for a duplicate name", async () => {
    const { org, alice, g, deps } = await setup();
    const [a, b] = await Promise.all([ensureCosmosCalendar(org.id, alice.id, deps), ensureCosmosCalendar(org.id, alice.id, deps)]);
    expect(a).toBe(b);
    expect(calendarPosts(g)).toBe(1);
    // Another instance won the race: our lookup missed it, our POST gets 409.
    const { id } = await credOf(org.id, alice.id);
    await patchCalendarMeta(id, {}, ["calendarId"]);
    let hideOnce = true;
    const racing = (async (url: unknown, init?: RequestInit) => {
      if (hideOnce && String(url).includes("/me/calendars?")) {
        hideOnce = false;
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      return g.fetch(url as string, init);
    }) as typeof fetch;
    expect(await ensureCosmosCalendar(org.id, alice.id, { ...deps, fetch: racing })).toBe(a);
    expect(g.calls.some((c) => c.method === "POST" && c.path === "/me/calendars")).toBe(true);
    expect([...g.calendars.values()].filter((c) => c.name === "Cosmos" && c.owner === `Bearer at-${alice.id}`)).toHaveLength(1);
  });

  it("a reconnect with a different Microsoft account starts clean", async () => {
    const { org, alice, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    await connect(org.id, alice, "someone-else-entirely");
    expect((await credOf(org.id, alice.id)).meta).not.toHaveProperty("calendarId");
    expect(await linkOf(alice.id, meeting.id)).toBeNull();
  });

  it("two orgs on one mailbox share the calendar, and disconnecting one leaves the other's events", async () => {
    const { org, alice, g, deps, meeting, stamp } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const org2 = await prisma.organization.create({ data: { name: `mss2 ${stamp}`, slug: `mss2-${stamp}` } });
    orgIds.push(org2.id);
    await prisma.orgMember.create({ data: { orgId: org2.id, userId: alice.id, role: "ADMIN" } });
    await prisma.integration.create({
      data: { orgId: org2.id, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId: TENANT }, status: "ACTIVE", installedById: alice.id },
    });
    await connect(org2.id, alice, `${alice.id}-${stamp}`); // the same Microsoft account
    const m2 = await prisma.syncMeeting.create({
      data: { orgId: org2.id, title: "Other org", meetingDate: START, createdById: alice.id, notes: "", attendees: { create: [{ userId: alice.id }] } },
    });
    await syncMeeting(org2.id, m2.id, deps);
    expect(calendarPosts(g)).toBe(2); // org2 reused alice's "Cosmos" calendar
    const one = (await linkOf(alice.id, meeting.id))!.externalEventId;
    const two = (await prisma.externalEventLink.findFirst({ where: { orgId: org2.id, entityId: m2.id } }))!.externalEventId;
    expect(await removeCosmosCalendar(org.id, alice.id, deps)).toBe(true);
    expect(g.events.get(one)!.removed).toBe(true);
    expect(g.events.get(two)!.removed).toBeFalsy();
    expect([...g.calendars.values()].some((c) => c.owner === `Bearer at-${alice.id}`)).toBe(true);
    // And org2's pull ignores org1's events in the shared calendar.
    expect(await pullChanges(org2.id, alice.id, deps)).toMatchObject({ applied: 0, ignored: 0 });
  });

  // ── Review fixes: the pull window, orphans, classification, fan-out ────────

  it("re-anchors the delta window once it has drifted a week, and not before", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    await pullChanges(org.id, alice.id, deps);
    await pullChanges(org.id, alice.id, deps);
    expect(new Set(g.deltaWindows.map((w) => w.to)).size).toBe(1); // resumed, same window
    const { id } = await credOf(org.id, alice.id);
    await patchCalendarMeta(id, { windowEnd: new Date(Date.now() + 150 * 86_400_000).toISOString() });
    await pullChanges(org.id, alice.id, deps);
    const last = g.deltaWindows[g.deltaWindows.length - 1];
    expect(Date.parse(last.to) - Date.now()).toBeGreaterThan(179 * 86_400_000);
    expect(Date.parse(((await credOf(org.id, alice.id)).meta as { windowEnd: string }).windowEnd)).toBe(Date.parse(last.to));
  });

  it("an event moved outside the window comes back as a move, not a detach", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    await pullChanges(org.id, alice.id, deps);
    const link = (await linkOf(alice.id, meeting.id))!;
    const far = new Date(Date.now() + 400 * 86_400_000);
    far.setUTCMilliseconds(0);
    await new Promise((r) => setTimeout(r, 5));
    g.outlookEdit(link.externalEventId, { start: at(far), end: at(new Date(far.getTime() + 45 * 60_000)) });
    expect(await pullChanges(org.id, alice.id, deps)).toMatchObject({ applied: 1, detached: 0 });
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).meetingDate).toEqual(far);
    expect(await linkOf(alice.id, meeting.id)).toBeTruthy();
  });

  it("retries a removal that failed, at the next pull", async () => {
    const { org, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const bEvent = (await linkOf(bob.id, meeting.id))!.externalEventId;
    await prisma.meetingAttendee.deleteMany({ where: { meetingId: meeting.id, userId: bob.id } });
    g.throttleNext(3); // the DELETE fails: 429, 429, 429
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.events.get(bEvent)!.removed).toBeFalsy();
    expect(await linkOf(bob.id, meeting.id)).toBeTruthy(); // kept, so it can be retried
    await pullChanges(org.id, bob.id, deps);
    expect(g.events.get(bEvent)!.removed).toBe(true);
    expect(await linkOf(bob.id, meeting.id)).toBeNull();
  });

  it("deletes the Outlook copy when a pull finds its meeting gone", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const aEvent = (await linkOf(alice.id, meeting.id))!.externalEventId;
    await prisma.syncMeeting.delete({ where: { id: meeting.id } }); // no push ran
    await new Promise((r) => setTimeout(r, 5));
    g.outlookEdit(aEvent, { subject: "edited after the meeting went" });
    await pullChanges(org.id, alice.id, deps);
    expect(g.events.get(aEvent)!.removed).toBe(true);
  });

  it("scrubs copies when the classification changes, which no meeting edit records", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const aEvent = (await linkOf(alice.id, meeting.id))!.externalEventId;
    await prisma.dataClassification.create({ data: { orgId: org.id, level: "FOUO", appliedById: alice.id } });
    await pullChanges(org.id, alice.id, deps);
    expect(g.events.get(aEvent)!).toMatchObject({ subject: "Cosmos item", body: { content: "" }, location: { displayName: "" } });
  });

  it("doesn't re-send a meeting whose Outlook view didn't change (a notes edit)", async () => {
    const { org, deps, g, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const writes = () => g.calls.filter((c) => c.method === "PATCH" || c.method === "POST").length;
    const before = writes();
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { notes: "minutes from today" } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(writes()).toBe(before);
  });

  it("treats a marking in the meeting link as classified too", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { meetingUrl: "https://meet.example/CUI//SP-PRVCY-review" } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.events.get((await linkOf(alice.id, meeting.id))!.externalEventId)!.subject).toBe("Cosmos item");
    expect(JSON.stringify(g.calls)).not.toMatch(/meet\.example|Sprint review/);
  });

  it("leaves the time alone for an all-day Outlook event, and bounds what an edit can set", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const link = (await linkOf(alice.id, meeting.id))!;
    await new Promise((r) => setTimeout(r, 5));
    g.outlookEdit(link.externalEventId, { isAllDay: true, start: at(new Date("2026-11-09T00:00:00.000Z")), end: at(new Date("2026-11-10T00:00:00.000Z")) } as never);
    await pullChanges(org.id, alice.id, deps);
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).meetingDate).toEqual(START);
    await new Promise((r) => setTimeout(r, 5));
    g.outlookEdit(link.externalEventId, {
      isAllDay: false, subject: "x".repeat(400),
      start: at(START), end: at(new Date(START.getTime() + 3 * 86_400_000)),
    } as never);
    await pullChanges(org.id, alice.id, deps);
    const m = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(m.durationMinutes).toBe(24 * 60);
    expect(m.title).toHaveLength(255);
  });

  it("stops a pull when it's aborted, keeping the old delta position", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    await pullChanges(org.id, alice.id, deps);
    const before = ((await credOf(org.id, alice.id)).meta as { deltaLink: string }).deltaLink;
    await new Promise((r) => setTimeout(r, 5));
    g.outlookEdit((await linkOf(alice.id, meeting.id))!.externalEventId, { subject: "Edited while we stopped" });
    const ac = new AbortController();
    ac.abort();
    expect(await pullChanges(org.id, alice.id, { ...deps, signal: ac.signal })).toEqual({ applied: 0, ignored: 0, echoes: 0, detached: 0 });
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).title).toBe("Sprint review");
    expect(((await credOf(org.id, alice.id)).meta as { deltaLink: string }).deltaLink).toBe(before);
    // The next, unhurried pull picks the edit up.
    expect(await pullChanges(org.id, alice.id, deps)).toMatchObject({ applied: 1 });
  });

  it("runs at most 4 Graph writes at once", async () => {
    let inFlight = 0;
    let max = 0;
    await pool(Array.from({ length: 10 }, (_, i) => i), 4, async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(max).toBe(4);
  });


  // ── Review fixes: only ever our own calendar ───────────────────────────────

  it("leaves a person's own 'Cosmos' calendar alone through connect, sync and disconnect", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    const token = `Bearer at-${alice.id}`;
    const personal = g.addCalendar({ name: "Cosmos", owner: token });
    const dentist = g.addEvent(personal, "Dentist (personal)");
    await syncMeeting(org.id, meeting.id, deps);
    const mine = ((await credOf(org.id, alice.id)).meta as { calendarId: string }).calendarId;
    expect(mine).not.toBe(personal);
    expect(g.calendars.get(mine)!.name).toBe("Cosmos (synced)");
    expect(g.eventsIn(personal).map((e) => e.subject)).toEqual(["Dentist (personal)"]);
    expect(g.calls.filter((c) => c.method !== "GET" && c.path.includes(personal))).toEqual([]);
    expect(await removeCosmosCalendar(org.id, alice.id, deps)).toBe(true);
    expect(g.calendars.has(personal)).toBe(true);
    expect(g.events.get(dentist)!.removed).toBeFalsy();
    expect(g.calendars.has(mine)).toBe(false); // ours, tagged, is deleted
  });

  it("never adopts a calendar shared with them, or a read-only one, even one tagged by someone else's Cosmos", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    const aliceToken = `Bearer at-${alice.id}`;
    const tag = [{ id: "String {15a54a29-b645-4cc8-988e-1a2322894aac} Name CosmosCalendar", value: "cosmos-calendar" }];
    const bobs = g.addCalendar({ name: "Cosmos", owner: `Bearer at-${bob.id}`, sharedWith: [aliceToken], canEdit: true, props: tag });
    const subscription = g.addCalendar({ name: "Cosmos (synced)", owner: aliceToken, canEdit: false, props: tag });
    await ensureCosmosCalendar(org.id, alice.id, deps);
    const mine = ((await credOf(org.id, alice.id)).meta as { calendarId: string }).calendarId;
    expect([bobs, subscription]).not.toContain(mine);
    expect(g.calendars.get(mine)!.name).toBe("Cosmos (synced 2)");
    // Only alice attends, so nothing at all should land in bob's calendar.
    await prisma.meetingAttendee.deleteMany({ where: { meetingId: meeting.id, userId: bob.id } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.calls.filter((c) => c.method !== "GET" && (c.path.includes(bobs) || c.path.includes(subscription)))).toEqual([]);
  });

  it("disconnect deletes only our events when the recorded calendar isn't one we tagged", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const { id, meta } = await credOf(org.id, alice.id);
    const cal = (meta as { calendarId: string }).calendarId;
    g.calendars.get(cal)!.props = []; // say an older build adopted it
    const keep = g.addEvent(cal, "Their own event");
    void id;
    expect(await removeCosmosCalendar(org.id, alice.id, deps)).toBe(true);
    expect(g.calendars.has(cal)).toBe(true);
    expect(g.events.get(keep)!.removed).toBeFalsy();
    expect(g.eventsIn(cal).map((e) => e.subject)).toEqual(["Their own event"]);
  });

  it("recovers when our calendar was deleted in Outlook: a new one, and the meetings go back in", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const old = ((await credOf(org.id, alice.id)).meta as { calendarId: string }).calendarId;
    g.calendars.delete(old); // they deleted it in Outlook
    // A push to a new meeting: the 404 is caught, the calendar re-made.
    const m2 = await prisma.syncMeeting.create({
      data: { orgId: org.id, title: "Retro", meetingDate: START, createdById: alice.id, notes: "", attendees: { create: [{ userId: alice.id }] } },
    });
    await syncMeeting(org.id, m2.id, deps);
    const fresh = ((await credOf(org.id, alice.id)).meta as { calendarId: string }).calendarId;
    expect(fresh).not.toBe(old);
    expect(g.eventsIn(fresh).map((e) => e.subject)).toContain("Retro");
    // And a pull puts the rest back.
    await pullChanges(org.id, alice.id, deps);
    expect(g.eventsIn(fresh).map((e) => e.subject).sort()).toEqual(["Retro", "Sprint review"]);
  });


  it("a pull that finds our calendar gone makes a new one and puts the meetings back", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const old = ((await credOf(org.id, alice.id)).meta as { calendarId: string }).calendarId;
    g.calendars.delete(old);
    await pullChanges(org.id, alice.id, deps);
    const fresh = ((await credOf(org.id, alice.id)).meta as { calendarId: string }).calendarId;
    expect(fresh).not.toBe(old);
    expect(g.eventsIn(fresh).map((e) => e.subject)).toEqual(["Sprint review"]);
    expect((await linkOf(alice.id, meeting.id))!.externalCalendarId).toBe(fresh);
  });


  it("recognises our calendar when the mailbox's address isn't its UPN", async () => {
    const { org, alice, g, deps, stamp } = await setup();
    g.setAddress(`Bearer at-${alice.id}`, "a.smith@corp.example"); // calendars report this owner
    await connect(org.id, alice, `${alice.id}-${stamp}`, "a.smith@corp.example");
    expect((await credOf(org.id, alice.id)).meta).toMatchObject({ mail: "a.smith@corp.example", upn: "alice@test.local" });
    const first = await ensureCosmosCalendar(org.id, alice.id, deps);
    const { id } = await credOf(org.id, alice.id);
    await patchCalendarMeta(id, {}, ["calendarId"]);
    expect(await ensureCosmosCalendar(org.id, alice.id, deps)).toBe(first); // adopted, not "Cosmos (synced)"
    expect(calendarPosts(g)).toBe(1);
  });

  it("disconnect deletes the calendar we recorded even when its owner matches neither address", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    g.setAddress(`Bearer at-${alice.id}`, "someone.else@corp.example");
    await syncMeeting(org.id, meeting.id, deps);
    const cal = ((await credOf(org.id, alice.id)).meta as { calendarId: string }).calendarId;
    expect(await removeCosmosCalendar(org.id, alice.id, deps)).toBe(true);
    expect(g.calendars.has(cal)).toBe(false);
  });


  // ── Invite mode ────────────────────────────────────────────────────────────

  const aliceEvent = async (orgId: string, aliceId: string, meetingId: string, g: ReturnType<typeof fakeGraph>) =>
    g.events.get((await linkOf(aliceId, meetingId))!.externalEventId)!;
  const attendeesOf = (e: unknown) => ((e as { attendees?: { emailAddress: { address: string } }[] }).attendees ?? []).map((a) => a.emailAddress.address);

  it("turning invitations on puts the attendees on the organizer's event and pauses everyone else's copy", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const bobCopy = (await linkOf(bob.id, meeting.id))!.externalEventId;
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    expect(attendeesOf(await aliceEvent(org.id, alice.id, meeting.id, g))).toEqual(["bob@test.local"]);
    expect(g.events.get(bobCopy)!.removed).toBe(true); // the invitation is his copy now
    expect(await linkOf(bob.id, meeting.id)).toBeNull();
    const sent = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: "microsoft_calendar.invite_sent" } });
    expect(sent?.metadata).toMatchObject({ recipientCount: "1", outsideDomainCount: "0" });
    // His own Sync now doesn't bring the duplicate back.
    await syncUserNow(org.id, bob.id, deps);
    expect(await linkOf(bob.id, meeting.id)).toBeNull();
  });

  it("refuses to turn on for a classified meeting, someone who can't edit it, or someone not connected", async () => {
    const { org, alice, bob, deps, meeting } = await setup();
    await expect(setMeetingInvite(org.id, meeting.id, bob.id, true, deps)).rejects.toMatchObject({ reason: "cannot_edit" });
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "CUI//SP-PRVCY review" } });
    await expect(setMeetingInvite(org.id, meeting.id, alice.id, true, deps)).rejects.toMatchObject({ reason: "classified" });
    expect((await invitePreview(org.id, meeting.id, alice.id))!).toMatchObject({ canChange: false, reason: "classified" });
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Sprint review" } });
    await disconnectCalendar(org.id, alice.id);
    await expect(setMeetingInvite(org.id, meeting.id, alice.id, true, deps)).rejects.toMatchObject({ reason: "not_connected" });
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).inviteOrganizerId).toBeNull();
  });

  it("warns about attendees outside the org's domains, and audits domains, never addresses", async () => {
    const { org, alice, deps, meeting } = await setup();
    await prisma.orgSecuritySettings.create({ data: { orgId: org.id, allowedDomains: ["contoso.example"] } });
    const p = (await invitePreview(org.id, meeting.id, alice.id))!;
    expect(p.recipients).toEqual([{ name: expect.any(String), email: "bob@test.local", outside: true }]);
    expect(p.domains).toEqual(["contoso.example"]);
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const sent = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "microsoft_calendar.invite_sent" } });
    expect(sent.metadata).toMatchObject({ outsideDomainCount: "1", outsideDomains: "test.local" });
    expect(JSON.stringify(sent.metadata)).not.toContain("bob@");
  });

  it("edits and attendee changes go out as updates; the audit says which parts changed", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Sprint review (moved)", meetingDate: new Date("2026-11-02T16:00:00.000Z") } });
    await syncMeeting(org.id, meeting.id, deps);
    const ev = await aliceEvent(org.id, alice.id, meeting.id, g);
    expect(ev.subject).toBe("Sprint review (moved)");
    const upd = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "microsoft_calendar.invite_updated" } });
    expect((upd.metadata as { fields: string }).fields).toBe("time, title");
    const carol = await prisma.user.findFirstOrThrow({ where: { email: "carol@test.local" } });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: carol.id, role: "MEMBER" } });
    await prisma.meetingAttendee.create({ data: { meetingId: meeting.id, userId: carol.id } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(attendeesOf(await aliceEvent(org.id, alice.id, meeting.id, g)).sort()).toEqual(["bob@test.local", "carol@test.local"]);
    // Notes don't reach Outlook, so they send nothing.
    const writes = g.calls.filter((c) => c.method === "PATCH").length;
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { notes: "agenda" } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.calls.filter((c) => c.method === "PATCH").length).toBe(writes);
  });

  it("turning it off sends a cancellation and gives everyone their mirrored copy back", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const invite = (await linkOf(alice.id, meeting.id))!.externalEventId;
    await setMeetingInvite(org.id, meeting.id, alice.id, false, deps);
    expect(g.cancellations.map((c) => c.eventId)).toEqual([invite]);
    expect(g.cancellations[0].comment).toBe("This meeting was cancelled.");
    // Scrubbed first on every stop, not only a classified one.
    expect(g.cancellations[0].subject).toBe("Meeting cancelled");
    expect(g.calls.filter((c) => c.path.includes(invite)).map((c) => c.method)).toEqual(["PATCH", "POST"]);
    // Mirror mode again: both have an ordinary copy, nobody lost the meeting.
    for (const u of [alice, bob]) {
      const l = (await linkOf(u.id, meeting.id))!;
      expect(l.contentHash?.startsWith("invite:")).toBe(false);
      expect(g.events.get(l.externalEventId)!.removed).toBeFalsy();
      expect(attendeesOf(g.events.get(l.externalEventId))).toEqual([]);
    }
    expect((await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "microsoft_calendar.invite_cancelled" } })).metadata).toMatchObject({ reason: "turned_off" });
  });

  it("a meeting that becomes classified cancels its invitation with nothing of the meeting in it", async () => {
    const { org, alice, alice: _a, g, deps, meeting } = await setup();
    void _a;
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { meetingUrl: "https://meet.example/xyz" } });
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const inviteId = (await linkOf(alice.id, meeting.id))!.externalEventId;
    const before = g.calls.length;
    await prisma.dataClassification.create({ data: { orgId: org.id, level: "FOUO", appliedById: alice.id } });
    await syncMeeting(org.id, meeting.id, deps);
    const sentToInvite = g.calls.slice(before).filter((c) => c.path.includes(inviteId));
    expect(sentToInvite.map((c) => c.method)).toEqual(["PATCH", "POST"]); // scrub, then cancel
    const payload = JSON.stringify(sentToInvite.map((c) => c.body));
    for (const field of ["Sprint review", "meet.example", meeting.id, "cosmos.example"]) expect(payload).not.toContain(field);
    expect(g.cancellations).toEqual([expect.objectContaining({ eventId: inviteId, subject: "Meeting cancelled", comment: "This meeting was cancelled." })]);
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).inviteOrganizerId).toBeNull();
    // Back to mirroring, as a bare busy block.
    expect(g.events.get((await linkOf(alice.id, meeting.id))!.externalEventId)!.subject).toBe("Cosmos item");
  });

  it("an invitation whose attendees grow past the cap is cancelled, and can't be turned back on", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const emails = Array.from({ length: MAX_INVITEES }, (_, i) => `cap-${stamp}-${i}@test.local`);
    await prisma.user.createMany({ data: emails.map((email) => ({ email, displayName: email })) });
    const extra = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
    try {
      await prisma.meetingAttendee.createMany({ data: extra.map((u) => ({ meetingId: meeting.id, userId: u.id })) });
      await syncMeeting(org.id, meeting.id, deps);
      expect(g.cancellations).toHaveLength(1);
      expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).inviteOrganizerId).toBeNull();
      expect((await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "microsoft_calendar.invite_cancelled" } })).metadata).toMatchObject({ reason: "too_many_attendees" });
      await expect(setMeetingInvite(org.id, meeting.id, alice.id, true, deps)).rejects.toMatchObject({ reason: "too_many_attendees" });
    } finally {
      await prisma.meetingAttendee.deleteMany({ where: { meetingId: meeting.id, userId: { in: extra.map((u) => u.id) } } });
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
    }
  });

  it("cancelling or deleting the meeting in Cosmos sends a cancellation, not a silent delete", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const inviteId = (await linkOf(alice.id, meeting.id))!.externalEventId;
    await prisma.syncMeeting.delete({ where: { id: meeting.id } });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.cancellations.map((c) => c.eventId)).toEqual([inviteId]);
    expect(g.calls.some((c) => c.method === "DELETE" && c.path.includes(inviteId))).toBe(false);
  });

  it("an Outlook edit to the invitation that's ignored is overwritten with the attendees still on it", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    await pullChanges(org.id, alice.id, deps);
    const id = (await linkOf(alice.id, meeting.id))!.externalEventId;
    g.outlookEdit(id, { subject: "Outlook title" });
    await new Promise((r) => setTimeout(r, 5));
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Cosmos title" } }); // cosmos newer
    await pullChanges(org.id, alice.id, deps);
    expect(attendeesOf(g.events.get(id))).toEqual(["bob@test.local"]);
    expect(g.cancellations).toEqual([]);
  });

  it("disconnecting: keep leaves the invitations (and their calendar) in Outlook; cancel cancels them", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const cal = ((await credOf(org.id, alice.id)).meta as { calendarId: string }).calendarId;
    const inviteId = (await linkOf(alice.id, meeting.id))!.externalEventId;
    expect(await liveInvites(org.id, alice.id)).toHaveLength(1);
    await releaseInvitesOnDisconnect(org.id, alice.id, "keep", deps);
    await removeCosmosCalendar(org.id, alice.id, deps);
    expect(g.calendars.has(cal)).toBe(true);
    expect(g.events.get(inviteId)!.removed).toBeFalsy();
    expect(g.cancellations).toEqual([]);
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).inviteOrganizerId).toBeNull();
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: "microsoft_calendar.invite_released" } })).toBe(1);
    expect((await invitePreview(org.id, meeting.id, bob.id))!.ended).toMatchObject({ how: "released", reason: "organizer_disconnected" });

    const two = await setup();
    await setMeetingInvite(two.org.id, two.meeting.id, two.alice.id, true, two.deps);
    await releaseInvitesOnDisconnect(two.org.id, two.alice.id, "cancel", two.deps);
    expect(two.g.cancellations).toHaveLength(1);
    expect((await invitePreview(two.org.id, two.meeting.id, two.alice.id))!.ended).toMatchObject({ how: "cancelled", reason: "organizer_disconnected" });
    await setMeetingInvite(two.org.id, two.meeting.id, two.alice.id, true, two.deps);
    expect((await invitePreview(two.org.id, two.meeting.id, two.alice.id))!.ended).toBeNull();
  });

  it("when the organizer leaves the org, their invitations are cancelled, audited, and the admins told", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    await prisma.orgMember.updateMany({ where: { orgId: org.id, userId: bob.id }, data: { role: "ADMIN" } });
    await prisma.orgMember.deleteMany({ where: { orgId: org.id, userId: alice.id } }); // she leaves
    await pullChanges(org.id, alice.id, deps).catch(() => undefined); // the next token use finds it
    expect(g.cancellations).toHaveLength(1);
    expect(await prisma.connectorCredential.count({ where: { orgId: org.id, userId: alice.id } })).toBe(0);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "microsoft_calendar.invite_cancelled" } })).metadata).toMatchObject({ reason: "organizer_left" });
    const note = await prisma.notification.findFirst({ where: { orgId: org.id, userId: bob.id, type: "integration.outlook_invites_cancelled" } });
    expect(note?.title).toBe("Outlook invitations cancelled (1)");
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).inviteOrganizerId).toBeNull();
  });

  it("offboardInvites works as the connection goes, even with the integration switched off", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    await prisma.integration.updateMany({ where: { orgId: org.id, provider: MS_CALENDAR }, data: { status: "INACTIVE" } });
    await offboardInvites(org.id, alice.id, "integration_disabled", deps);
    expect(g.cancellations).toHaveLength(1);
  });

  it("the preview says when the org has Outlook Calendar off, so the meeting page can stay quiet", async () => {
    const { org, alice, meeting } = await setup();
    expect((await invitePreview(org.id, meeting.id, alice.id))!.available).toBe(true);
    await prisma.integration.updateMany({ where: { orgId: org.id, provider: MS_CALENDAR }, data: { status: "INACTIVE" } });
    expect((await invitePreview(org.id, meeting.id, alice.id))!.available).toBe(false);
  });

  it("limits each person to 10 invitation toggles an hour", async () => {
    const { org, alice, deps, meeting } = await setup();
    rl.real = true;
    try {
      for (let i = 0; i < 10; i++) await setMeetingInvite(org.id, meeting.id, alice.id, i % 2 === 0, deps);
      await expect(setMeetingInvite(org.id, meeting.id, alice.id, true, deps)).rejects.toBeInstanceOf(InviteRefused);
    } finally {
      rl.real = false;
    }
  });

  // ── #1140 review ───────────────────────────────────────────────────────────

  it("invites only active members who may see the meeting: not another org's user, a leaver, or someone without the project", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [outsider, leaver, member] = await Promise.all(
      ["outsider", "leaver", "member"].map((n) => prisma.user.create({ data: { email: `${n}-${stamp}@test.local`, displayName: n } })),
    );
    try {
      const project = await prisma.project.create({ data: { orgId: org.id, name: "Locked", key: `LK${stamp.slice(-4).replace(/[^a-z0-9]/gi, "").toUpperCase()}`, teamScopedAccess: true } });
      await prisma.orgMember.createMany({
        data: [
          { orgId: org.id, userId: leaver.id, role: "MEMBER", removedAt: new Date() },
          { orgId: org.id, userId: member.id, role: "MEMBER" },
        ],
      });
      // bob (VIEWER) and the member aren't on the team-scoped project; alice (ADMIN) sees it anyway.
      const bobMember = await prisma.orgMember.findFirstOrThrow({ where: { orgId: org.id, userId: bob.id } });
      await prisma.projectMember.create({ data: { projectId: project.id, orgMemberId: bobMember.id } });
      await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { projectId: project.id } });
      await prisma.meetingAttendee.createMany({ data: [outsider, leaver, member].map((u) => ({ meetingId: meeting.id, userId: u.id })) });
      expect((await invitePreview(org.id, meeting.id, alice.id))!.recipients.map((r) => r.email)).toEqual(["bob@test.local"]);
      await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
      expect(attendeesOf(await aliceEvent(org.id, alice.id, meeting.id, g))).toEqual(["bob@test.local"]);
    } finally {
      await prisma.meetingAttendee.deleteMany({ where: { meetingId: meeting.id } });
      await prisma.user.deleteMany({ where: { id: { in: [outsider.id, leaver.id, member.id] } } });
    }
  });

  it("gives the invitation's addresses only to someone who can edit the meeting", async () => {
    const { org, alice, bob, meeting } = await setup();
    expect((await invitePreview(org.id, meeting.id, alice.id))!.recipients).toHaveLength(1);
    expect((await invitePreview(org.id, meeting.id, bob.id))!.recipients).toEqual([]);
  });

  it("both copies of the edit check hold: a viewer can't turn it off, and the preview tells them why they can't turn it on", async () => {
    const { org, alice, bob, deps, meeting } = await setup();
    expect((await invitePreview(org.id, meeting.id, bob.id))!).toMatchObject({ canChange: false, reason: "cannot_edit" });
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    await expect(setMeetingInvite(org.id, meeting.id, bob.id, false, deps)).rejects.toMatchObject({ reason: "cannot_edit" });
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).inviteOrganizerId).toBe(alice.id);
  });

  it("a cancellation that can't be delivered stays pending: never patched into a mirror copy, retried once reconnected", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const invite = (await linkOf(alice.id, meeting.id))!.externalEventId;
    const cred = await credOf(org.id, alice.id);
    await patchCalendarMeta(cred.id, { status: "reconnect" });
    const before = g.calls.length;
    await setMeetingInvite(org.id, meeting.id, alice.id, false, deps);
    expect(g.calls.slice(before)).toEqual([]); // nothing sent to Outlook, nothing turned into a copy
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).inviteOrganizerId).toBe(alice.id);
    expect((await invitePreview(org.id, meeting.id, alice.id))!).toMatchObject({ on: true, pendingCancel: true });
    expect(await prisma.notification.count({ where: { orgId: org.id, userId: alice.id, type: "integration.outlook_invite_cancel_pending" } })).toBe(1);
    // Syncs meanwhile change nothing, and nobody gets a mirror copy of it.
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.calls.slice(before)).toEqual([]);
    expect(await linkOf(bob.id, meeting.id)).toBeNull();
    // Reconnected: the next sync delivers the cancellation, then mirroring resumes on a fresh event.
    await patchCalendarMeta(cred.id, { status: "connected" });
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.cancellations.map((c) => c.eventId)).toEqual([invite]);
    expect(g.calls.filter((c) => c.method === "PATCH" && c.path.includes(invite)).map((c) => (c.body as { subject?: string }).subject)).toEqual(["Meeting cancelled"]);
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } })).inviteOrganizerId).toBeNull();
    const mirror = (await linkOf(alice.id, meeting.id))!;
    expect(mirror.externalEventId).not.toBe(invite);
    expect(attendeesOf(g.events.get(mirror.externalEventId))).toEqual([]);
    expect(await linkOf(bob.id, meeting.id)).not.toBeNull();
  });

  it("an invitation is never patched into a mirror copy: it is cancelled and a fresh copy made", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const invite = (await linkOf(alice.id, meeting.id))!.externalEventId;
    // Invite mode ends without its cancellation (as an offboard that couldn't reach Microsoft does).
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { inviteOrganizerId: null } });
    const before = g.calls.length;
    await syncMeeting(org.id, meeting.id, deps);
    const toInvite = g.calls.slice(before).filter((c) => c.path.includes(invite));
    expect(toInvite.map((c) => c.method)).toEqual(["PATCH", "POST"]); // scrub, cancel: never a mirror body
    expect((toInvite[0].body as { subject: string }).subject).toBe("Meeting cancelled");
    const mirror = (await linkOf(alice.id, meeting.id))!;
    expect(mirror.externalEventId).not.toBe(invite);
    expect(mirror.contentHash?.startsWith("invite:")).toBe(false);
  });

  it("an ignored Outlook edit re-sends the invitation only if it may still go out", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    await pullChanges(org.id, alice.id, deps);
    const id = (await linkOf(alice.id, meeting.id))!.externalEventId;
    // She can no longer edit the meeting; her Outlook edit is ignored, and the invitation can't continue.
    await prisma.orgMember.updateMany({ where: { orgId: org.id, userId: alice.id }, data: { role: "VIEWER" } });
    g.outlookEdit(id, { subject: "Outlook title" });
    const before = g.calls.length;
    await pullChanges(org.id, alice.id, deps);
    const patches = g.calls.slice(before).filter((c) => c.method === "PATCH" && c.path.includes(id));
    expect(patches.every((c) => !(c.body as { attendees?: unknown }).attendees)).toBe(true);
    expect(g.cancellations.map((c) => c.eventId)).toEqual([id]);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "microsoft_calendar.invite_cancelled" } })).metadata).toMatchObject({ reason: "organizer_cannot_edit" });
  });

  it("two editors turning it on at once: one sends, the other is told it's already on", async () => {
    const { org, alice, deps, meeting, stamp } = await setup();
    const carol = await prisma.user.findFirstOrThrow({ where: { email: "carol@test.local" } });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: carol.id, role: "ADMIN" } });
    await connect(org.id, carol, `${carol.id}-${stamp}`);
    const r = await Promise.allSettled([alice, carol].map((u) => setMeetingInvite(org.id, meeting.id, u.id, true, deps)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.find((x) => x.status === "rejected")).toMatchObject({ reason: { reason: "already_on" } });
  });

  it("a cancellation is never held back by the organizer's invitation budget", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    rl.denyOps = true;
    try {
      await prisma.dataClassification.create({ data: { orgId: org.id, level: "FOUO", appliedById: alice.id } });
      await syncMeeting(org.id, meeting.id, deps);
      expect(g.cancellations).toHaveLength(1);
    } finally {
      rl.denyOps = false;
    }
  });

  it("raising a classification re-checks live invitations at once", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    const other = await setup(); // another org's invitation is left alone
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    await setMeetingInvite(other.org.id, other.meeting.id, other.alice.id, true, other.deps);
    await prisma.dataClassification.create({ data: { orgId: org.id, level: "FOUO", appliedById: alice.id } });
    const n = await syncInvitesAfterClassification(org.id, null, (o, id) => syncMeeting(o, id, deps));
    expect(n).toBe(1);
    expect(g.cancellations).toHaveLength(1);
    expect(other.g.cancellations).toEqual([]);
  });

});
