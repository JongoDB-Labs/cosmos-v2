// COSMOS-202 (e2e DB): per-person sharing levels and the org-wide default for
// what Cosmos publishes into Outlook. Against an in-memory Graph: a person on
// free/busy only gets bare busy blocks (and no title typed into one comes
// back), the org default decides for anyone who hasn't chosen, and a choice
// survives a reconnect.
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db/client";

// The Microsoft sign-in app, without the shared global row (and its vault key)
// that another test file may be writing at the same time.
vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () => ({ enabled: true, clientId: "client-id", clientSecret: "client-secret", tenant: null }),
}));

import { fakeGraph } from "@/lib/testing/fake-graph";
import { MS_CALENDAR } from "./calendar-connect";
import type { SharingLevel } from "./calendar-sharing";
import {
  _resetCalendarTokenCache, calendarConnection, calendarSharingState, completeCalendarConnect, patchCalendarMeta,
} from "./calendar-token.server";
import { pullChanges, syncMeeting } from "./calendar-sync.server";

const TENANT = "11111111-2222-3333-4444-555555555555";
const jwt = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;
const START = new Date("2026-11-02T15:00:00.000Z");
const at = (d: Date) => ({ dateTime: d.toISOString().slice(0, 23) + "0000", timeZone: "UTC" });

const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
beforeAll(() => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
});
afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

describe("Outlook sharing levels (e2e DB)", () => {
  const orgIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  });
  beforeEach(() => _resetCalendarTokenCache());

  async function connect(orgId: string, u: { id: string; email: string }, oid: string) {
    const fetchFn = (async (url: unknown) =>
      String(url).includes("/me?")
        ? new Response(JSON.stringify({ mail: null, userPrincipalName: u.email }), { status: 200 })
        : new Response(
            JSON.stringify({ access_token: `at-${u.id}`, refresh_token: "rt", expires_in: 3600, id_token: jwt({ tid: TENANT, oid, preferred_username: u.email }) }),
            { status: 200 },
          )) as unknown as typeof fetch;
    await completeCalendarConnect(
      { orgId, userId: u.id, code: "c", verifier: "v", redirectUri: "https://x/cb", origin: "https://cosmos.example" },
      { fetch: fetchFn },
    );
  }

  /** alice (ADMIN) and bob (VIEWER), both connected, with one meeting they both attend. */
  async function setup(orgDefault?: SharingLevel) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
    const org = await prisma.organization.create({
      data: {
        name: `mssh ${stamp}`, slug: `mssh-${stamp}`,
        ...(orgDefault ? { settings: { outlookCalendar: { sharingLevel: orgDefault } } } : {}),
      },
    });
    orgIds.push(org.id);
    await prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: alice.id, role: "ADMIN" },
        { orgId: org.id, userId: bob.id, role: "VIEWER" },
      ],
    });
    await prisma.integration.create({
      data: {
        orgId: org.id, provider: MS_CALENDAR, displayName: "Outlook Calendar", status: "ACTIVE", installedById: alice.id,
        config: { tenantId: TENANT },
      },
    });
    for (const u of [alice, bob]) await connect(org.id, u, `${u.id}-${stamp}`);
    const g = fakeGraph();
    for (const u of [alice, bob]) g.setAddress(`Bearer at-${u.id}`, u.email);
    const meeting = await prisma.syncMeeting.create({
      data: {
        orgId: org.id, title: "Sprint review", meetingDate: START, durationMinutes: 45, createdById: alice.id, notes: "",
        meetingUrl: "https://meet.example/abc",
        attendees: { create: [{ userId: alice.id }, { userId: bob.id }] },
      },
    });
    return { org, alice, bob, g, deps: { fetch: g.fetch, sleep: g.sleep }, meeting };
  }

  const linkOf = (userId: string, meetingId: string) =>
    prisma.externalEventLink.findFirst({ where: { provider: MS_CALENDAR, userId, entityType: "meeting", entityId: meetingId } });

  /** One person's choice, as the sharing API stores it. */
  async function choose(orgId: string, userId: string, level: SharingLevel) {
    const conn = await calendarConnection(orgId, userId);
    await patchCalendarMeta(conn!.id, { sharingLevel: level });
  }

  const eventFor = async (g: ReturnType<typeof fakeGraph>, userId: string, meetingId: string) =>
    g.events.get((await linkOf(userId, meetingId))!.externalEventId)!;

  it("publishes a bare busy block for a person on free/busy only, and full details for one who isn't", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await choose(org.id, alice.id, "busy");
    await syncMeeting(org.id, meeting.id, deps);

    const aEv = await eventFor(g, alice.id, meeting.id);
    expect(aEv.subject).toBe("Cosmos item");
    expect(aEv.body?.content).toBe("");
    expect(aEv.showAs).toBe("busy");
    // The times are still hers to the minute: free/busy, not nothing.
    expect(aEv.start.dateTime).toBe("2026-11-02T15:00:00.000");
    expect(aEv.end.dateTime).toBe("2026-11-02T15:45:00.000");
    // Nothing about the meeting reached her mailbox.
    const herCalls = g.calls.filter((c) => c.path.includes(aEv.calendarId) || c.path.includes(aEv.id));
    expect(JSON.stringify(herCalls)).not.toMatch(/Sprint review|meet\.example|\/meetings\//);

    const bEv = await eventFor(g, bob.id, meeting.id);
    expect(bEv.subject).toBe("Sprint review");
    expect(bEv.body?.content).toContain(`https://cosmos.example/${org.slug}/meetings/${meeting.id}`);
  });

  it("uses the org-wide default for anyone who hasn't chosen, and lets one person choose otherwise", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup("busy");
    expect(await calendarSharingState(org.id, (await calendarConnection(org.id, bob.id))!.meta)).toEqual({
      level: "default", orgDefault: "busy", effective: "busy",
    });
    await syncMeeting(org.id, meeting.id, deps);
    for (const u of [alice, bob]) expect((await eventFor(g, u.id, meeting.id)).subject).toBe("Cosmos item");

    // Alice decides her own calendar may carry the details; bob still follows the org.
    await choose(org.id, alice.id, "full");
    await syncMeeting(org.id, meeting.id, deps);
    const aEv = await eventFor(g, alice.id, meeting.id);
    expect(aEv.subject).toBe("Sprint review");
    expect(aEv.body?.content).toContain("Join: https://meet.example/abc");
    expect((await eventFor(g, bob.id, meeting.id)).subject).toBe("Cosmos item");
  });

  it("never takes a title back from a busy-only copy, while its time still comes back", async () => {
    const { org, alice, g, deps, meeting } = await setup("busy");
    await syncMeeting(org.id, meeting.id, deps);
    const link = (await linkOf(alice.id, meeting.id))!;
    await new Promise((r) => setTimeout(r, 5));
    const moved = new Date("2026-11-04T10:00:00.000Z");
    g.outlookEdit(link.externalEventId, {
      start: at(moved), end: at(new Date(moved.getTime() + 45 * 60_000)), subject: "My guess at the title",
    });
    expect(await pullChanges(org.id, alice.id, deps)).toMatchObject({ applied: 1 });
    const m = await prisma.syncMeeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(m.meetingDate).toEqual(moved);
    expect(m.title).toBe("Sprint review");
    // Everything pushed after the change it caused is still bare.
    expect(JSON.stringify(g.calls)).not.toMatch(/Sprint review|meet\.example|\/meetings\//);
    // Her next pull is quiet: her copy is recorded at the level she is on.
    expect(await pullChanges(org.id, alice.id, deps)).toMatchObject({ applied: 0, ignored: 0 });
  });

  it("keeps a person's choice when they reconnect", async () => {
    const { org, alice } = await setup();
    await choose(org.id, alice.id, "busy");
    await connect(org.id, alice, `${alice.id}-again`);
    expect((await calendarConnection(org.id, alice.id))!.meta.sharingLevel).toBe("busy");
  });
});
