// COSMOS-202 (B2, e2e DB): Cosmos meetings mirrored into each attendee's
// Outlook "Cosmos" calendar, and Outlook edits brought back. Against an
// in-memory Graph: echoes of our own writes are skipped; an edit by someone
// who can't edit the meeting is ignored, audit-logged and overwritten; a
// classified meeting is a bare busy block going out and only its time comes
// back; Retry-After is honoured.
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { fakeGraph } from "@/lib/testing/fake-graph";
import { MS_CALENDAR } from "./calendar-connect";
import { _resetCalendarTokenCache, completeCalendarConnect, disconnectCalendar } from "./calendar-token.server";
import { pullChanges, removeCosmosCalendar, runCalendarPulls, syncMeeting, syncUserNow } from "./calendar-sync.server";

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
    for (const u of [alice, bob]) {
      const fetchFn = (async () =>
        new Response(
          JSON.stringify({ access_token: `at-${u.id}`, refresh_token: "rt", expires_in: 3600, id_token: jwt({ tid: TENANT, oid: u.id, preferred_username: u.email }) }),
          { status: 200 },
        )) as unknown as typeof fetch;
      await completeCalendarConnect(
        { orgId: org.id, userId: u.id, code: "c", verifier: "v", redirectUri: "https://x/cb", origin: "https://cosmos.example" },
        { fetch: fetchFn },
      );
    }
    const g = fakeGraph();
    const deps = { fetch: g.fetch, sleep: g.sleep };
    const meeting = await prisma.syncMeeting.create({
      data: {
        orgId: org.id, title: "Sprint review", meetingDate: START, durationMinutes: 45, createdById: alice.id, notes: "",
        meetingUrl: "https://meet.example/abc",
        attendees: { create: [{ userId: alice.id }, { userId: bob.id }] },
      },
    });
    return { org, alice, bob, g, deps, meeting };
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

  it("Sync now pushes the person's meetings and pulls; disconnecting removes the calendar and the links", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    const r = await syncUserNow(org.id, alice.id, deps);
    expect(r).toMatchObject({ echoes: 1 });
    expect(await linkOf(alice.id, meeting.id)).toBeTruthy();
    const conn = await prisma.connectorCredential.findFirstOrThrow({ where: { orgId: org.id, userId: alice.id, provider: MS_CALENDAR } });
    expect((conn.meta as { lastSyncAt?: string }).lastSyncAt).toBeTruthy();
    expect(await removeCosmosCalendar(org.id, alice.id, deps)).toBe(true);
    expect(g.calendars.size).toBe(0);
    await disconnectCalendar(org.id, alice.id);
    expect(await prisma.externalEventLink.count({ where: { orgId: org.id, userId: alice.id } })).toBe(0);
  });
});
