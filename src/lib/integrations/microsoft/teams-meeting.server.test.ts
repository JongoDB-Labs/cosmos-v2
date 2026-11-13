// Teams meetings for Cosmos meetings pushed to Outlook (e2e DB). Against the
// in-memory Graph: one Outlook event (the host's) asks Microsoft for a Teams
// meeting, its join link is kept on the meeting, and everyone else's copy
// carries the link as text. An edit keeps the same Teams meeting; Microsoft
// answering without one never fails the sync.
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db/client";

// Per-person invitation and toggle limits are in-process buckets: let them through.
vi.mock("@/lib/rate-limit/bucket", async (orig) => {
  const actual = await orig<typeof import("@/lib/rate-limit/bucket")>();
  return { ...actual, rateLimit: () => ({ allowed: true as const, remaining: 99 }) };
});
import { fakeGraph } from "@/lib/testing/fake-graph";
import { MS_CALENDAR } from "./calendar-connect";
import { _resetCalendarTokenCache, completeCalendarConnect, disconnectCalendar, patchCalendarMeta } from "./calendar-token.server";
import {
  MEETING_SYNC_LOCK, TeamsRefused, disconnectOutlook, invitePreview, offboardOrgTeams, pullChanges, setMeetingInvite, setMeetingTeams,
  syncInvitesAfterClassification, syncMeeting, syncUserNow, teamsPreview, teamsRefusalForNew,
} from "./calendar-sync.server";

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

/** An hour from now: inside every window the sync uses, and never in the past. */
const START = new Date(Math.floor((Date.now() + 60 * 60 * 1000) / 1000) * 1000);
const TEAMS = { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" };

describe("Teams meetings through Outlook (e2e DB)", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
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

  /**
   * alice edits meetings (ADMIN), bob only reads them (VIEWER); both connected.
   * Users are this file's own: nothing here touches the shared seeded ones.
   */
  async function setup(opts: { teams?: boolean; attendees?: ("alice" | "bob")[] } = {}) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.create({ data: { email: `alice-${stamp}@teams.test`, displayName: "Alice" } });
    const bob = await prisma.user.create({ data: { email: `bob-${stamp}@teams.test`, displayName: "Bob" } });
    userIds.push(alice.id, bob.id);
    const org = await prisma.organization.create({ data: { name: `tms ${stamp}`, slug: `tms-${stamp}` } });
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
    const people = { alice, bob };
    const meeting = await prisma.syncMeeting.create({
      data: {
        orgId: org.id, title: "Sprint review", meetingDate: START, durationMinutes: 45, createdById: alice.id, notes: "",
        teamsHostId: opts.teams === false ? null : alice.id,
        attendees: { create: (opts.attendees ?? ["alice", "bob"]).map((k) => ({ userId: people[k].id })) },
      },
    });
    return { org, alice, bob, g, deps, meeting };
  }

  const linkOf = (userId: string, meetingId: string) =>
    prisma.externalEventLink.findFirst({ where: { provider: MS_CALENDAR, userId, entityType: "meeting", entityId: meetingId } });
  const eventOf = async (g: ReturnType<typeof fakeGraph>, userId: string, meetingId: string) => {
    const link = await linkOf(userId, meetingId);
    return link ? g.events.get(link.externalEventId) : undefined;
  };
  const row = (id: string) => prisma.syncMeeting.findUniqueOrThrow({ where: { id } });
  /** The Teams meetings still live in this person's Outlook: their event is there and not deleted. */
  const liveTeams = (g: ReturnType<typeof fakeGraph>, u: { id: string }) =>
    g.teamsMeetings.filter((t) => t.owner === `Bearer at-${u.id}` && g.events.has(t.eventId) && !g.events.get(t.eventId)!.removed);
  /** Every write to Graph that asked for a Teams meeting. */
  const askedForTeams = (g: ReturnType<typeof fakeGraph>) =>
    g.calls.filter((c) => (c.method === "POST" || c.method === "PATCH") && c.body?.isOnlineMeeting === true);

  it("makes the host's Outlook event a Teams meeting and keeps its join link on the meeting", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    expect(await syncMeeting(org.id, meeting.id, deps)).toEqual([]);

    expect(g.teamsMeetings).toHaveLength(1);
    const hostEvent = (await eventOf(g, alice.id, meeting.id))!;
    expect(hostEvent).toMatchObject(TEAMS);
    const joinUrl = g.teamsMeetings[0].joinUrl;
    expect(hostEvent.onlineMeeting?.joinUrl).toBe(joinUrl);
    const m = await row(meeting.id);
    expect(m.teamsJoinUrl).toBe(joinUrl);
    expect(m.teamsIssue).toBeNull();

    // Everyone else's copy shows the same link; it is never a Teams meeting of its own.
    const bobs = (await eventOf(g, bob.id, meeting.id))!;
    expect(bobs.isOnlineMeeting).toBeUndefined();
    expect(bobs.body?.content).toContain(`Join the Teams meeting: ${joinUrl}`);
    expect(askedForTeams(g)).toHaveLength(1);

    // Keeping the link the host's write brought back is not a change to their event.
    const writes = g.calls.length;
    expect(await syncMeeting(org.id, meeting.id, deps)).toEqual([]);
    expect(g.calls.slice(writes).filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("with Teams off, no event asks for a Teams meeting and no link is kept", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup({ teams: false });
    await syncMeeting(org.id, meeting.id, deps);
    // Both copies landed (the probe below can see events), and neither is a Teams meeting.
    expect(await eventOf(g, alice.id, meeting.id)).toBeTruthy();
    expect(await eventOf(g, bob.id, meeting.id)).toBeTruthy();
    expect(askedForTeams(g)).toEqual([]);
    expect(g.teamsMeetings).toEqual([]);
    expect((await eventOf(g, bob.id, meeting.id))!.body?.content).not.toContain("Teams");
    expect((await row(meeting.id)).teamsJoinUrl).toBeNull();
  });

  it("an edit keeps the same Teams meeting and link, and never makes a second one", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const joinUrl = (await row(meeting.id)).teamsJoinUrl;
    expect(joinUrl).toBeTruthy();
    const hostEventId = (await linkOf(alice.id, meeting.id))!.externalEventId;

    const later = new Date(START.getTime() + 30 * 60_000);
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Sprint review (moved)", meetingDate: later } });
    expect(await syncMeeting(org.id, meeting.id, deps)).toEqual([]);

    // Updated in place: the same event, the same Teams meeting, the same link.
    expect((await linkOf(alice.id, meeting.id))!.externalEventId).toBe(hostEventId);
    expect(g.calls.filter((c) => c.method === "PATCH" && c.path.includes(hostEventId))).toHaveLength(1);
    expect(g.teamsMeetings).toHaveLength(1);
    const hostEvent = g.events.get(hostEventId)!;
    expect(hostEvent.subject).toBe("Sprint review (moved)");
    expect(hostEvent.onlineMeeting?.joinUrl).toBe(joinUrl);
    expect((await row(meeting.id)).teamsJoinUrl).toBe(joinUrl);
    // The edit's own body now carries the link too, for whoever reads the event text.
    expect(hostEvent.body?.content).toContain(`Join the Teams meeting: ${joinUrl}`);
    expect((await eventOf(g, bob.id, meeting.id))!.body?.content).toContain(`Join the Teams meeting: ${joinUrl}`);

    // Keeping the link Microsoft gave never re-sends anything by itself.
    const writes = g.calls.length;
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.calls.slice(writes).filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("keeping the join link does not count as the meeting changing", async () => {
    const { org, deps, meeting } = await setup();
    const before = await row(meeting.id);
    await syncMeeting(org.id, meeting.id, deps);
    const after = await row(meeting.id);
    expect(after.teamsJoinUrl).toBeTruthy();
    // updatedAt decides who wins a conflict and whether a copy someone deleted comes back.
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("Microsoft makes the event but no Teams meeting: every copy still lands, and why is kept", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    g.teamsOff(`Bearer at-${alice.id}`);
    // Not a failure: the sync reports nothing unsynced.
    expect(await syncMeeting(org.id, meeting.id, deps)).toEqual([]);
    expect(askedForTeams(g)).toHaveLength(1);
    expect(await eventOf(g, alice.id, meeting.id)).toBeTruthy();
    expect(await eventOf(g, bob.id, meeting.id)).toBeTruthy();
    const m = await row(meeting.id);
    expect(m.teamsJoinUrl).toBeNull();
    expect(m.teamsIssue).toBe("no_join_url");
    expect(m.teamsHostId).toBe(alice.id); // still asked for: a later change tries again
    const p = (await teamsPreview(org.id, meeting.id, alice.id))!;
    expect(p).toMatchObject({ on: true, joinUrl: null, status: "no_join_url" });
  });

  it("Graph refusing the Teams fields: the event is written without them", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    g.teamsRefused(`Bearer at-${alice.id}`);
    expect(await syncMeeting(org.id, meeting.id, deps)).toEqual([]);
    const ev = (await eventOf(g, alice.id, meeting.id))!;
    expect(ev.subject).toBe("Sprint review");
    expect(ev.isOnlineMeeting).toBeUndefined();
    expect((await row(meeting.id)).teamsIssue).toBe("no_join_url");
    // And it isn't retried on every sync: only a change to the meeting tries again.
    const asks = askedForTeams(g).length;
    await syncMeeting(org.id, meeting.id, deps);
    expect(askedForTeams(g)).toHaveLength(asks);
  });

  it("the host gets the Teams meeting in their Outlook even when not attending", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup({ attendees: ["bob"] });
    await syncMeeting(org.id, meeting.id, deps);
    expect((await eventOf(g, alice.id, meeting.id))!).toMatchObject(TEAMS);
    const joinUrl = (await row(meeting.id)).teamsJoinUrl!;
    expect(joinUrl).toBeTruthy();
    expect((await eventOf(g, bob.id, meeting.id))!.body?.content).toContain(joinUrl);
    // The host's own reconcile keeps their copy rather than removing it as "not attending".
    await syncUserNow(org.id, alice.id, deps);
    expect(await eventOf(g, alice.id, meeting.id)).toBeTruthy();
    expect(g.teamsMeetings).toHaveLength(1);
  });

  it("the host's reconcile makes the Teams meeting when no push ever did", async () => {
    const { org, alice, g, deps, meeting } = await setup({ attendees: ["bob"] });
    // As if the push on save failed: nothing in Outlook yet, and alice isn't attending.
    await syncUserNow(org.id, alice.id, deps);
    expect((await eventOf(g, alice.id, meeting.id))!).toMatchObject(TEAMS);
    expect((await row(meeting.id)).teamsJoinUrl).toBe(g.teamsMeetings[0]?.joinUrl);
  });

  it("with Outlook invitations on, the invitation carries the Teams meeting, and the link survives the switch", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const joinUrl = (await row(meeting.id)).teamsJoinUrl;
    expect(joinUrl).toBeTruthy();

    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const inv = (await eventOf(g, alice.id, meeting.id))! as unknown as { attendees?: unknown[]; onlineMeeting?: { joinUrl: string } };
    expect(inv.attendees).toHaveLength(1); // bob is invited on the Teams event itself
    expect(inv.onlineMeeting?.joinUrl).toBe(joinUrl);
    expect(g.teamsMeetings).toHaveLength(1);
    expect((await row(meeting.id)).teamsJoinUrl).toBe(joinUrl);
    // Nothing is sent to the invitees again just for the link being kept.
    const writes = g.calls.length;
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.calls.slice(writes).filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("with invitations already out, the organizer's toggle makes the invitation the Teams meeting, updated once", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup({ teams: false });
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    const inviteId = (await linkOf(alice.id, meeting.id))!.externalEventId;
    // Only the organizer's Outlook can hold it while invitations are on, even for another editor.
    await prisma.orgMember.updateMany({ where: { orgId: org.id, userId: bob.id }, data: { role: "ADMIN" } });
    await expect(setMeetingTeams(org.id, meeting.id, bob.id, true, deps)).rejects.toMatchObject({ reason: "invites_by_someone_else" });

    await setMeetingTeams(org.id, meeting.id, alice.id, true, deps);
    expect((await linkOf(alice.id, meeting.id))!.externalEventId).toBe(inviteId); // the same invitation
    expect(g.teamsMeetings).toEqual([expect.objectContaining({ eventId: inviteId })]);
    expect((await row(meeting.id)).teamsJoinUrl).toBe(g.teamsMeetings[0].joinUrl);
    const audits = () => prisma.auditLog.count({ where: { entityId: meeting.id, action: "microsoft_calendar.invite_updated" } });
    expect(await audits()).toBe(1);
    // Keeping the link sends the invitees nothing more.
    const writes = g.calls.length;
    await syncMeeting(org.id, meeting.id, deps);
    expect(g.calls.slice(writes).filter((c) => c.method !== "GET")).toEqual([]);
    expect(await audits()).toBe(1);
    // An invitation that went out with it can't lose it: stop the invitations first.
    expect((await teamsPreview(org.id, meeting.id, alice.id))!).toMatchObject({ on: true, canChange: false, reason: "invite_sent" });
    await expect(setMeetingTeams(org.id, meeting.id, alice.id, false, deps)).rejects.toMatchObject({ reason: "invite_sent" });
  });

  it("turning invitations on is refused while someone else hosts the Teams meeting, and theirs stays", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    // bob hosts it in mirror mode (as if he had edit rights when he turned it on).
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { teamsHostId: bob.id } });
    await syncMeeting(org.id, meeting.id, deps);
    const bobsUrl = (await row(meeting.id)).teamsJoinUrl;
    expect(bobsUrl).toBeTruthy();

    await expect(setMeetingInvite(org.id, meeting.id, alice.id, true, deps)).rejects.toMatchObject({ reason: "teams_hosted_by_someone_else", hostId: bob.id });
    expect(await row(meeting.id)).toMatchObject({ inviteOrganizerId: null, teamsHostId: bob.id, teamsJoinUrl: bobsUrl });
    expect(liveTeams(g, bob).map((t) => t.joinUrl)).toEqual([bobsUrl]); // never ended behind his back
    // The preview says so before anyone tries.
    expect(await invitePreview(org.id, meeting.id, alice.id)).toMatchObject({ reason: "teams_hosted_by_someone_else", teamsHostId: bob.id, canChange: false });
    // The positive control: with Teams off, alice turns invitations on.
    await setMeetingTeams(org.id, meeting.id, alice.id, false, deps);
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    expect((await row(meeting.id)).inviteOrganizerId).toBe(alice.id);
  });

  it("turning Teams off takes the Teams meeting out of the host's Outlook", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const oldEventId = (await linkOf(alice.id, meeting.id))!.externalEventId;

    await setMeetingTeams(org.id, meeting.id, alice.id, false, deps);
    const m = await row(meeting.id);
    expect(m).toMatchObject({ teamsHostId: null, teamsJoinUrl: null, teamsIssue: null });
    // Outlook can't take a Teams meeting off an event: the old one is deleted and a plain copy made.
    expect(g.events.get(oldEventId)!.removed).toBe(true);
    const fresh = (await eventOf(g, alice.id, meeting.id))!;
    expect(fresh.id).not.toBe(oldEventId);
    expect(fresh.isOnlineMeeting).toBeUndefined();
    expect((await eventOf(g, bob.id, meeting.id))!.body?.content).not.toContain("Teams");
    expect(await prisma.activity.count({ where: { subjectId: meeting.id, action: "teams_off", newValue: "turned_off" } })).toBe(1);
  });

  it("turning Teams on for an existing meeting makes it once; a second toggle is a no-op", async () => {
    const { org, alice, g, deps, meeting } = await setup({ teams: false });
    await syncMeeting(org.id, meeting.id, deps);
    const eventId = (await linkOf(alice.id, meeting.id))!.externalEventId;
    await setMeetingTeams(org.id, meeting.id, alice.id, true, deps);
    await setMeetingTeams(org.id, meeting.id, alice.id, true, deps);
    // The existing copy is updated into the Teams meeting, not replaced.
    expect((await linkOf(alice.id, meeting.id))!.externalEventId).toBe(eventId);
    expect(g.teamsMeetings).toHaveLength(1);
    expect((await row(meeting.id)).teamsJoinUrl).toBe(g.teamsMeetings[0].joinUrl);
  });

  it("refuses someone who can't edit the meeting, or isn't connected", async () => {
    const { org, alice, bob, deps, meeting } = await setup({ teams: false });
    await expect(setMeetingTeams(org.id, meeting.id, bob.id, true, deps)).rejects.toMatchObject({ reason: "cannot_edit" });
    await disconnectCalendar(org.id, alice.id);
    await expect(setMeetingTeams(org.id, meeting.id, alice.id, true, deps)).rejects.toBeInstanceOf(TeamsRefused);
    expect(await teamsRefusalForNew(org.id, alice.id, { projectId: null, title: "x" })).toBe("not_connected");
    expect((await row(meeting.id)).teamsHostId).toBeNull();
  });

  it("the host deleting the Teams event in Outlook clears the link, and it stays deleted", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    await pullChanges(org.id, alice.id, deps); // anchors the delta
    g.outlookDelete((await linkOf(alice.id, meeting.id))!.externalEventId);
    const r = await pullChanges(org.id, alice.id, deps);
    expect(r.detached).toBe(1);
    const m = await row(meeting.id);
    expect(m.teamsJoinUrl).toBeNull();
    expect(await linkOf(alice.id, meeting.id)).toBeNull();
    expect(g.teamsMeetings).toHaveLength(1); // no new one made behind their back
  });

  it("the host disconnecting Outlook ends the Teams meeting", async () => {
    const { org, alice, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    expect((await row(meeting.id)).teamsJoinUrl).toBeTruthy();
    await disconnectCalendar(org.id, alice.id);
    expect(await row(meeting.id)).toMatchObject({ teamsHostId: null, teamsJoinUrl: null });
  });

  it("a cancelled meeting loses its link, and gets a new one if it's back on", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const first = (await row(meeting.id)).teamsJoinUrl;
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { status: "CANCELLED" } });
    await syncMeeting(org.id, meeting.id, deps);
    expect((await row(meeting.id)).teamsJoinUrl).toBeNull();
    expect(await linkOf(alice.id, meeting.id)).toBeNull();
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { status: "SCHEDULED" } });
    await syncMeeting(org.id, meeting.id, deps);
    const second = (await row(meeting.id)).teamsJoinUrl;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(g.teamsMeetings).toHaveLength(2);
  });

  it("is refused for a classified meeting, and one that becomes classified loses it", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    expect((await row(meeting.id)).teamsJoinUrl).toBeTruthy();
    await prisma.dataClassification.create({ data: { orgId: org.id, level: "FOUO", appliedById: alice.id } });
    // Re-checked at once, as live invitations are: no meeting edit records a classification.
    expect(await syncInvitesAfterClassification(org.id, null, (o, id) => syncMeeting(o, id, deps))).toBe(1);
    const m = await row(meeting.id);
    expect(m).toMatchObject({ teamsHostId: null, teamsJoinUrl: null });
    expect((await eventOf(g, alice.id, meeting.id))!.isOnlineMeeting).toBeUndefined();
    expect((await eventOf(g, bob.id, meeting.id))!.body?.content).not.toContain("teams.microsoft.com");
    expect(await teamsRefusalForNew(org.id, alice.id, { projectId: null, title: "x" })).toBe("classified");
  });

  it("only its own host's write sets the link", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const url = (await row(meeting.id)).teamsJoinUrl;
    // bob's reconcile writes his copy; it never touches the link.
    await patchCalendarMeta((await prisma.connectorCredential.findFirstOrThrow({ where: { orgId: org.id, userId: bob.id } })).id, {}, ["deltaLink"]);
    await syncUserNow(org.id, bob.id, deps);
    expect((await row(meeting.id)).teamsJoinUrl).toBe(url);
    expect(g.teamsMeetings.every((t) => t.owner === `Bearer at-${alice.id}`)).toBe(true);
  });

  it("two syncs of one meeting at once make one Teams meeting", async () => {
    const { org, alice, g, meeting } = await setup();
    // Microsoft is slow making the host's Teams meeting; meanwhile the meeting is renamed and its own sync starts.
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const atGate = new Promise<void>((r) => (reached = r));
    let held = false;
    const slow = (async (input: unknown, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (!held && auth === `Bearer at-${alice.id}` && init?.method === "POST" && /\/events$/.test(String(input)) && body?.isOnlineMeeting) {
        held = true;
        reached();
        await gate;
      }
      return g.fetch(input as never, init);
    }) as unknown as typeof fetch;
    const deps = { fetch: slow, sleep: g.sleep };
    const first = syncMeeting(org.id, meeting.id, deps);
    await atGate;
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Sprint review (moved)" } });
    const second = syncMeeting(org.id, meeting.id, deps);
    // As far as the second can get on its own: all the way, unless something holds it off.
    await Promise.race([second, new Promise((r) => setTimeout(r, 3000))]);
    release();
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(liveTeams(g, alice)).toHaveLength(1);
    const m = await row(meeting.id);
    expect(m.teamsJoinUrl).toBe(liveTeams(g, alice)[0].joinUrl);
    expect((await eventOf(g, alice.id, meeting.id))!.subject).toBe("Sprint review (moved)");
  });

  it("another process syncing the same meeting holds this sync off until it is done", async () => {
    const { org, g, deps, meeting } = await setup();
    let sync: Promise<string[]> | null = null;
    let callsWhileHeld = -1;
    expect(typeof MEETING_SYNC_LOCK).toBe("number");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MEETING_SYNC_LOCK}::int, hashtext(${meeting.id}))`;
      sync = syncMeeting(org.id, meeting.id, deps);
      // All the way through, unless the lock holds it off.
      await Promise.race([sync, new Promise((r) => setTimeout(r, 3000))]);
      callsWhileHeld = g.calls.length;
    }, { timeout: 15_000 });
    expect(callsWhileHeld).toBe(0); // nothing reached Outlook while the other held it
    expect(await sync!).toEqual([]);
    expect(g.teamsMeetings).toHaveLength(1);
  });

  it("a host create Microsoft made but whose answer was lost is not made twice after an edit", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    expect(liveTeams(g, alice)).toHaveLength(1);
    // The answer never arrived: no link kept, no join link recorded.
    await prisma.externalEventLink.deleteMany({ where: { userId: alice.id, entityId: meeting.id } });
    await prisma.$executeRaw`UPDATE sync_meetings SET teams_join_url = NULL WHERE id = ${meeting.id}::uuid`;
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Sprint review (moved)" } });
    expect(await syncMeeting(org.id, meeting.id, deps)).toEqual([]);
    expect(liveTeams(g, alice)).toHaveLength(1); // Graph matched the retried create to the one it made
    const ev = (await eventOf(g, alice.id, meeting.id))!;
    expect(ev.subject).toBe("Sprint review (moved)"); // and the edit still reached it
    expect((await row(meeting.id)).teamsJoinUrl).toBe(liveTeams(g, alice)[0].joinUrl);
  });

  it("a meeting that becomes classified without a sync ends its Teams meeting at the host's reconcile, and keeps no dead link", async () => {
    const { org, alice, bob, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const first = (await row(meeting.id)).teamsJoinUrl;
    expect(first).toBeTruthy();
    // A marking in the title, written by a path that pushes nothing.
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "CUI Sprint review" } });
    await syncUserNow(org.id, alice.id, deps); // the reconcile pass
    expect(liveTeams(g, alice)).toHaveLength(0);
    expect(await row(meeting.id)).toMatchObject({ teamsHostId: null, teamsJoinUrl: null, teamsIssue: null });
    expect(await prisma.activity.count({ where: { subjectId: meeting.id, action: "teams_off", newValue: "classified" } })).toBe(1);
    expect(await teamsPreview(org.id, meeting.id, bob.id)).toMatchObject({ on: false, joinUrl: null, status: null });
    // Unmarked: Teams stays off, and nobody's copy carries the dead link.
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "Sprint review" } });
    await syncMeeting(org.id, meeting.id, deps);
    await syncUserNow(org.id, bob.id, deps);
    expect((await eventOf(g, bob.id, meeting.id))!.body?.content).not.toContain(String(first));
    expect(g.teamsMeetings).toHaveLength(1);
  });

  it("with invitations on, a meeting classified while the organizer must reconnect still drops its join link", async () => {
    const { org, alice, deps, meeting } = await setup();
    await setMeetingInvite(org.id, meeting.id, alice.id, true, deps);
    expect((await row(meeting.id)).teamsJoinUrl).toBeTruthy();
    const cred = await prisma.connectorCredential.findFirstOrThrow({ where: { orgId: org.id, userId: alice.id } });
    await patchCalendarMeta(cred.id, { status: "reconnect" });
    await prisma.syncMeeting.update({ where: { id: meeting.id }, data: { title: "CUI Sprint review" } });
    await syncMeeting(org.id, meeting.id, deps);
    // The cancellation waits for alice; the link, shown to everyone who can see the meeting, doesn't.
    expect(await row(meeting.id)).toMatchObject({ teamsHostId: null, teamsJoinUrl: null });
  });

  it("the host leaving the org ends their Teams meetings in Outlook before the connection goes", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    expect(liveTeams(g, alice)).toHaveLength(1);
    await prisma.orgMember.deleteMany({ where: { orgId: org.id, userId: alice.id } });
    // The next use of their token finds they left: the connection is removed.
    await expect(syncUserNow(org.id, alice.id, deps)).rejects.toThrow();
    expect(liveTeams(g, alice)).toHaveLength(0);
    expect(await row(meeting.id)).toMatchObject({ teamsHostId: null, teamsJoinUrl: null });
    expect(await prisma.connectorCredential.count({ where: { orgId: org.id, userId: alice.id } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: "microsoft_calendar.teams_ended", userId: alice.id } });
    expect(audit?.metadata).toMatchObject({ ended: "1", failed: "0" });
  });

  it("the host disconnecting ends their Teams meetings in Outlook first, even when the Cosmos calendar can't go", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    const hostEvent = (await linkOf(alice.id, meeting.id))!.externalEventId;
    // A calendar shared with another of their connections is never deleted whole.
    const cred = await prisma.connectorCredential.findFirstOrThrow({ where: { orgId: org.id, userId: alice.id } });
    await prisma.connectorCredential.update({ where: { id: cred.id }, data: { meta: { ...(cred.meta as object), calendarId: "not-ours" } } });
    await disconnectOutlook(org.id, alice.id, deps);
    expect(g.calls.some((c) => c.method === "DELETE" && c.path === `/me/events/${hostEvent}`)).toBe(true);
    expect(liveTeams(g, alice)).toHaveLength(0);
    expect(await row(meeting.id)).toMatchObject({ teamsHostId: null, teamsJoinUrl: null });
  });

  it("an admin turning Outlook Calendar off ends every host's Teams meetings in Outlook first", async () => {
    const { org, alice, g, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    expect(liveTeams(g, alice)).toHaveLength(1);
    await offboardOrgTeams(org.id, deps);
    expect(liveTeams(g, alice)).toHaveLength(0);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: "microsoft_calendar.teams_ended", userId: alice.id } });
    expect(audit?.metadata).toMatchObject({ reason: "integration_disabled", ended: "1", failed: "0" });
  });

  it("however hosting ends, the join link goes with it: even a write that only clears the host", async () => {
    const { org, deps, meeting } = await setup();
    await syncMeeting(org.id, meeting.id, deps);
    expect((await row(meeting.id)).teamsJoinUrl).toBeTruthy();
    // What deleting the host's account does (ON DELETE SET NULL), or any write that forgets the rest.
    await prisma.$executeRaw`UPDATE sync_meetings SET teams_host_id = NULL WHERE id = ${meeting.id}::uuid`;
    expect(await row(meeting.id)).toMatchObject({ teamsHostId: null, teamsJoinUrl: null, teamsIssue: null });
  });
});
