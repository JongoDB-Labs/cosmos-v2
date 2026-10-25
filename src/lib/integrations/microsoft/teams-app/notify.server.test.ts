// COSMOS-202 T2 (e2e DB): the Cosmos bot in Teams. A chat is remembered only
// from a verified activity at the commercial Bot Connector; channel linking
// takes a project admin, the org's own tenant and an unrestricted project;
// anything else typed gets fixed help, never an echo. Every card is re-read
// as its recipient when sent (membership, Outlook link, app on, can they still
// see the item) and says only key, title and link; a restricted item is its
// key and "Restricted". Unlinking Outlook, leaving, or the app going off
// forgets the conversation.
import crypto from "node:crypto";
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { fakeBotConnector } from "@/lib/testing/fake-bot-connector";
import { MS_CALENDAR } from "../calendar-connect";

vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () => ({ clientId: "bot-app-id", clientSecret: "bot-app-secret" }),
}));

const { MS_TEAMS_APP } = await import("./identity.server");
const { handleActivity } = await import("./handlers.server");
const { parseCommand, PERSONAL_HELP, CHANNEL_HELP } = await import("./conversations.server");
const { drainTeamsOutbox, queueChannelDigests, queueDueDigests } = await import("./notify.server");
const { createNotification } = await import("@/lib/notifications/create");
const { disconnectCalendar } = await import("../calendar-token.server");
const { _resetBotTokens } = await import("./bot-connector.server");

const ORIGIN = "https://cosmos.example";
const SERVICE = "https://smba.trafficmanager.net/amer/";

describe("parseCommand: the fixed grammar", () => {
  it("link KEY and unlink, after the bot's @mention; everything else is help", () => {
    expect(parseCommand("<at>Cosmos</at> link acme")).toEqual({ kind: "link", key: "ACME" });
    expect(parseCommand("<at>Cosmos</at>&nbsp;unlink ")).toEqual({ kind: "unlink" });
    for (const t of ["link", "link ACME now", "link ACME; unlink", "link 1ACME", "please link ACME", "unlink ACME", "", undefined, "<b>link ACME</b>"]) {
      expect(parseCommand(t), String(t)).toEqual({ kind: "help" });
    }
  });
});

describe("Cosmos bot in Teams (e2e DB)", () => {
  const orgIds: string[] = [];
  const createdTypes: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
    await prisma.workItemType.deleteMany({ where: { id: { in: createdTypes } } }).catch(() => undefined);
  });
  beforeEach(() => _resetBotTokens());

  async function taskType() {
    const t = await prisma.workItemType.findFirst({ where: { isBuiltIn: true, key: "software.task" } });
    if (t) return t;
    const made = await prisma.workItemType.create({ data: { key: "software.task", name: "Task", isBuiltIn: true } });
    createdTypes.push(made.id);
    return made;
  }

  /** alice (ADMIN) and bob (MEMBER) connected Outlook in TENANT. */
  async function setup() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const TENANT = crypto.randomUUID();
    const [alice, bob] = await Promise.all(["alice", "bob"].map((n) => prisma.user.findFirstOrThrow({ where: { email: `${n}@test.local` } })));
    const org = await prisma.organization.create({ data: { name: `bot ${stamp}`, slug: `bot-${stamp}` } });
    orgIds.push(org.id);
    await prisma.orgMember.createMany({ data: [{ orgId: org.id, userId: alice.id, role: "ADMIN" }, { orgId: org.id, userId: bob.id, role: "MEMBER" }] });
    await prisma.integration.create({ data: { orgId: org.id, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId: TENANT }, status: "ACTIVE", installedById: alice.id } });
    const app = await prisma.integration.create({ data: { orgId: org.id, provider: MS_TEAMS_APP, displayName: "Cosmos for Teams", config: {}, status: "ACTIVE", installedById: alice.id } });
    const oid = (n: string) => `oid-${n}-${stamp}`;
    for (const [u, n] of [[alice, "alice"], [bob, "bob"]] as const) {
      await prisma.connectorCredential.create({ data: { orgId: org.id, provider: MS_CALENDAR, userId: u.id, secretEnc: "sealed", meta: { tid: TENANT, oid: oid(n), upn: u.email, status: "connected" } } });
    }
    const type = await taskType();
    const key = `BT${stamp.slice(-4).replace(/[^a-z0-9]/gi, "").toUpperCase()}X`;
    const project = await prisma.project.create({ data: { orgId: org.id, name: "Bot project", key } });
    await ensureFixtureStatuses(project.id, ["todo", "in_progress"], { todo: "TODO", in_progress: "IN_PROGRESS" });
    let n = 0;
    const item = (title: string, assignee: { id: string }, extra: object = {}) =>
      prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: ++n, title, description: "It loops forever, secretly.", columnKey: "todo",
          workItemTypeId: type.id, createdById: alice.id, assigneeId: assignee.id, assignees: { create: [{ userId: assignee.id, sortOrder: 0 }] }, ...extra,
        },
      });
    const personal = (who: string, text = "hi", over: Record<string, unknown> = {}) => ({
      type: "message", text, serviceUrl: SERVICE, from: { aadObjectId: oid(who) },
      conversation: { id: `a:personal-${who}-${stamp}`, conversationType: "personal", tenantId: TENANT },
      channelData: { tenant: { id: TENANT } }, ...over,
    });
    const channelId = `19:chan-${stamp}@thread.tacv2`;
    const channel = (who: string, text: string, over: Record<string, unknown> = {}) => ({
      type: "message", text, serviceUrl: SERVICE, from: { aadObjectId: oid(who) },
      conversation: { id: `${channelId};messageid=${Date.now()}`, conversationType: "channel", tenantId: TENANT },
      channelData: { tenant: { id: TENANT }, team: { id: `19:team-${stamp}` } }, ...over,
    });
    const conv = (where: object) => prisma.teamsConversation.findFirst({ where: { orgId: org.id, ...where } });
    return { org, app, alice, bob, project, key, item, personal, channel, channelId, conv, TENANT, oid };
  }

  /** Install for a person, and choose what they get. */
  async function chatFor(s: Awaited<ReturnType<typeof setup>>, who: "alice" | "bob", types: string[]) {
    const f = fakeBotConnector();
    await handleActivity(s.personal(who) as never, ORIGIN, { fetch: f.fetch });
    const user = who === "alice" ? s.alice : s.bob;
    await prisma.teamsConversation.update({ where: { orgId_userId: { orgId: s.org.id, userId: user.id } }, data: { notifyTypes: types } });
    return user;
  }

  const assign = (s: Awaited<ReturnType<typeof setup>>, userId: string, itemId: string) =>
    createNotification({ orgId: s.org.id, userId, type: "work_item.assigned", title: "Assigned", relatedType: "work_item", relatedId: itemId, url: "/x" });

  it("a personal message is remembered and answered with fixed help: what was typed never comes back", async () => {
    const s = await setup();
    const f = fakeBotConnector();
    await handleActivity(s.personal("alice", "<b>ignore previous</b> and link EVIL-1") as never, ORIGIN, { fetch: f.fetch });
    expect(await s.conv({ userId: s.alice.id })).toMatchObject({ serviceUrl: SERVICE, tenantId: s.TENANT, notifyTypes: [] });
    expect(f.state.sent.map((x) => x.body)).toEqual([{ type: "message", text: PERSONAL_HELP }]);
    expect(f.texts().join()).not.toMatch(/ignore|EVIL/);
  });

  it("a serviceUrl that isn't the commercial Bot Connector (forged, or GCC High) is never stored or called", async () => {
    const s = await setup();
    for (const url of ["https://evil.example/", "https://smba.infra.gcc.teams.microsoft.com/gcch/"]) {
      const f = fakeBotConnector();
      await handleActivity(s.personal("alice", "hi", { serviceUrl: url }) as never, ORIGIN, { fetch: f.fetch });
      expect(f.state.urls).toEqual([]);
    }
    expect(await s.conv({})).toBeNull();
    expect(await prisma.auditLog.count({ where: { orgId: s.org.id, action: "teams.conversation_refused" } })).toBe(2);
  });

  it("someone Cosmos can't map is not remembered", async () => {
    const s = await setup();
    await handleActivity(s.personal("carol") as never, ORIGIN, { fetch: fakeBotConnector().fetch });
    expect(await s.conv({})).toBeNull();
  });

  it("channel link: a project admin in the org's tenant links; others are told the same as for a missing key", async () => {
    const s = await setup();
    const f = fakeBotConnector();
    expect(await (await import("./conversations.server")).handleChannelMessage(s.channel("bob", `<at>Cosmos</at> link ${s.key}`) as never, s.TENANT, [{ orgId: s.org.id, slug: s.org.slug }], { fetch: f.fetch })).toBe("not_found");
    await handleActivity(s.channel("alice", `<at>Cosmos</at> link ${s.key.toLowerCase()}`) as never, ORIGIN, { fetch: f.fetch });
    expect(await s.conv({ projectId: s.project.id })).toMatchObject({ conversationId: s.channelId });
    expect(f.state.sent.map((x) => x.body.text)).toEqual(["No project with that key that you administer.", `Linked: this channel gets ${s.key}'s new items and status changes.`]);
    expect(await prisma.auditLog.count({ where: { orgId: s.org.id, action: "teams.channel_linked" } })).toBe(1);
  });

  it("channel link: refused for another tenant's team, a restricted project, and after 5 changes an hour", async () => {
    const s = await setup();
    const { handleChannelMessage } = await import("./conversations.server");
    const orgs = [{ orgId: s.org.id, slug: s.org.slug }];
    const f = fakeBotConnector();
    const other = { channelData: { tenant: { id: crypto.randomUUID() } } };
    expect(await handleChannelMessage(s.channel("alice", `link ${s.key}`, other) as never, s.TENANT, orgs, { fetch: f.fetch })).toBe("wrong_tenant");
    expect(await handleChannelMessage(s.channel("alice", `link ${s.key}`, { conversation: { id: s.channelId, conversationType: "channel", tenantId: crypto.randomUUID() } }) as never, s.TENANT, orgs, { fetch: f.fetch })).toBe("wrong_tenant");
    await prisma.dataClassification.create({ data: { orgId: s.org.id, projectId: s.project.id, level: "FOUO", appliedById: s.alice.id } });
    expect(await handleChannelMessage(s.channel("alice", `link ${s.key}`) as never, s.TENANT, orgs, { fetch: f.fetch })).toBe("restricted");
    expect(await handleChannelMessage(s.channel("alice", "unlink") as never, s.TENANT, orgs, { fetch: f.fetch })).toBe("nothing_to_unlink");
    expect(await handleChannelMessage(s.channel("alice", "unlink") as never, s.TENANT, orgs, { fetch: f.fetch })).toBe("nothing_to_unlink");
    expect(await handleChannelMessage(s.channel("alice", "unlink") as never, s.TENANT, orgs, { fetch: f.fetch })).toBe("rate_limited");
    expect(await s.conv({})).toBeNull();
    // Help in a channel needs no rate budget, and never echoes.
    const h = fakeBotConnector();
    expect(await handleChannelMessage(s.channel("alice", "what is the payroll") as never, s.TENANT, orgs, { fetch: h.fetch })).toBe("help");
    expect(h.state.sent.map((x) => x.body.text)).toEqual([CHANNEL_HELP]);
  });

  it("assigned: a card with key, title and link only, at send; a restricted item is its key and Restricted", async () => {
    const s = await setup();
    const alice = await chatFor(s, "alice", ["assigned"]);
    const a = await s.item("Fix the login page", alice);
    const b = await s.item("CUI//SP-PRVCY payroll", alice);
    await assign(s, alice.id, a.id);
    await assign(s, alice.id, b.id);
    // Mentions weren't chosen: not queued.
    await createNotification({ orgId: s.org.id, userId: alice.id, type: "comment.mentioned", title: "M", relatedType: "work_item", relatedId: a.id });
    expect(await prisma.teamsOutbox.count({ where: { orgId: s.org.id } })).toBe(2);
    expect(JSON.stringify(await prisma.teamsOutbox.findMany({ where: { orgId: s.org.id } }))).not.toMatch(/login|payroll/);
    const f = fakeBotConnector();
    expect(await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch } })).toMatchObject({ sent: 2 });
    const [first, second] = f.texts();
    expect(first).toContain("Assigned to you");
    expect(first).toContain(`${s.key}-1`);
    expect(first).toContain("Fix the login page");
    expect(first).toContain(`${ORIGIN}/${s.org.slug}/issues?item=${s.key}-1`);
    expect(second).toContain(`${s.key}-2`);
    expect(second).toContain("Restricted");
    expect(second).not.toContain("payroll");
    for (const t of f.texts()) expect(t).not.toMatch(/loops|secretly|Todo|Bot project|Alice/);
    expect(await prisma.teamsOutbox.count({ where: { orgId: s.org.id } })).toBe(0);
  });

  it("re-checks visibility at send: an item the person can no longer see is not sent", async () => {
    const s = await setup();
    const bob = await chatFor(s, "bob", ["assigned"]);
    const a = await s.item("Fix the login page", bob);
    await assign(s, bob.id, a.id);
    // Queued while bob could see it; then the project is limited to its members, and bob isn't one.
    await prisma.project.update({ where: { id: s.project.id }, data: { teamScopedAccess: true } });
    const f = fakeBotConnector();
    expect(await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch } })).toMatchObject({ sent: 0, dropped: 1 });
    expect(f.state.sent).toEqual([]);
  });

  it("someone who left the org: nothing is sent and their chat is forgotten", async () => {
    const s = await setup();
    const bob = await chatFor(s, "bob", ["assigned"]);
    const a = await s.item("Fix the login page", bob);
    await assign(s, bob.id, a.id);
    await prisma.orgMember.updateMany({ where: { orgId: s.org.id, userId: bob.id }, data: { removedAt: new Date() } });
    const f = fakeBotConnector();
    expect(await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch } })).toMatchObject({ sent: 0, forgotten: 1 });
    expect(f.state.sent).toEqual([]);
    expect(await s.conv({ userId: bob.id })).toBeNull();
  });

  it("removing your Outlook link forgets your Teams chat", async () => {
    const s = await setup();
    const alice = await chatFor(s, "alice", ["assigned"]);
    expect(await s.conv({ userId: alice.id })).not.toBeNull();
    await disconnectCalendar(s.org.id, alice.id);
    expect(await s.conv({ userId: alice.id })).toBeNull();
  });

  it("the Teams app switched off: nothing is sent and the org's conversations are forgotten", async () => {
    const s = await setup();
    const alice = await chatFor(s, "alice", ["assigned"]);
    await chatFor(s, "bob", ["assigned"]);
    await handleActivity(s.channel("alice", `link ${s.key}`) as never, ORIGIN, { fetch: fakeBotConnector().fetch });
    await assign(s, alice.id, (await s.item("Fix the login page", alice)).id);
    await prisma.integration.update({ where: { id: s.app.id }, data: { status: "INACTIVE" } });
    const f = fakeBotConnector();
    await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch } });
    expect(f.state.sent).toEqual([]);
    // All of them: bob's chat and the channel had nothing queued, and still go.
    expect(await prisma.teamsConversation.count({ where: { orgId: s.org.id } })).toBe(0);
  });

  it("429: retried after Teams' Retry-After; 403: the bot was removed, so the chat is forgotten", async () => {
    const s = await setup();
    const alice = await chatFor(s, "alice", ["assigned"]);
    await assign(s, alice.id, (await s.item("Fix the login page", alice)).id);
    const f = fakeBotConnector();
    f.state.next.push({ status: 429, retryAfter: "600" });
    const t0 = Date.now();
    expect(await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch }, now: () => t0 })).toMatchObject({ retried: 1 });
    const row = await prisma.teamsOutbox.findFirstOrThrow({ where: { orgId: s.org.id } });
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBe(t0 + 600_000);
    // Not due yet: nothing happens.
    expect(await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch }, now: () => t0 + 60_000 })).toMatchObject({ sent: 0, retried: 0 });
    f.state.next.push({ status: 403 });
    expect(await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch }, now: () => t0 + 601_000 })).toMatchObject({ forgotten: 1 });
    expect(await s.conv({})).toBeNull();
  });

  it("due tomorrow: one card a day, after 8 in the person's time zone, of their open items due tomorrow", async () => {
    const s = await setup();
    const alice = await chatFor(s, "alice", ["due_tomorrow"]);
    await s.item("Due tomorrow item", alice, { dueDate: new Date("2026-03-11T00:00:00Z") });
    await s.item("Due later item", alice, { dueDate: new Date("2026-03-12T00:00:00Z") });
    const early = new Date("2026-03-10T07:30:00Z");
    expect(await queueDueDigests(early)).toBe(0);
    const nine = new Date("2026-03-10T09:00:00Z");
    expect(await queueDueDigests(nine)).toBeGreaterThanOrEqual(1);
    const mine = () => prisma.teamsOutbox.count({ where: { orgId: s.org.id, kind: "due_digest" } });
    expect(await mine()).toBe(1);
    await queueDueDigests(new Date("2026-03-10T10:00:00Z"));
    expect(await mine()).toBe(1);
    // The next day, two runs at once (a leader change): still one card.
    await Promise.all([queueDueDigests(new Date("2026-03-11T09:00:00Z")), queueDueDigests(new Date("2026-03-11T09:00:00Z"))]);
    expect(await mine()).toBe(2);
    await prisma.teamsOutbox.deleteMany({ where: { orgId: s.org.id, kind: "due_digest", payload: { path: ["day"], equals: "2026-03-12" } } });
    const f = fakeBotConnector();
    await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch } });
    expect(f.texts()).toHaveLength(1);
    expect(f.texts()[0]).toContain("Due tomorrow item");
    expect(f.texts()[0]).not.toContain("Due later item");
  });

  it("channel updates: new items and status changes, one card, from the event cursor; stopped once the project is restricted", async () => {
    const s = await setup();
    await handleActivity(s.channel("alice", `link ${s.key}`) as never, ORIGIN, { fetch: fakeBotConnector().fetch });
    const a = await s.item("Brand new thing", s.alice);
    const b = await s.item("Moving thing", s.alice);
    const ev = (type: string, subjectId: string) => prisma.domainEvent.create({ data: { orgId: s.org.id, projectId: s.project.id, type, subjectId, source: "API" } });
    await ev("work_item.created", a.id);
    await ev("work_item.updated", b.id); // not a channel update
    await ev("work_item.transitioned", b.id);
    await queueChannelDigests();
    await queueChannelDigests(); // the cursor moved: nothing twice
    expect(await prisma.teamsOutbox.count({ where: { orgId: s.org.id } })).toBe(1);
    const f = fakeBotConnector();
    await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch } });
    expect(f.state.sent.map((x) => x.conversationId)).toEqual([s.channelId]);
    const t = f.texts()[0];
    expect(t).toContain(`${s.key}-1 · New`);
    expect(t).toContain(`${s.key}-2 · Status changed`);
    expect(t).not.toMatch(/loops|secretly/);
    await prisma.dataClassification.create({ data: { orgId: s.org.id, projectId: s.project.id, level: "FOUO", appliedById: s.alice.id } });
    await ev("work_item.created", b.id);
    await queueChannelDigests();
    expect(await s.conv({ projectId: s.project.id })).toBeNull();
    expect(await prisma.auditLog.count({ where: { orgId: s.org.id, action: "teams.channel_stopped" } })).toBe(1);
  });

  it("channel updates: after a gap, changes over 2 hours old are skipped, not posted; newer ones still are", async () => {
    const s = await setup();
    await handleActivity(s.channel("alice", `link ${s.key}`) as never, ORIGIN, { fetch: fakeBotConnector().fetch });
    const old = await s.item("Old news", s.alice);
    const fresh = await s.item("Fresh news", s.alice);
    const at = (type: string, subjectId: string, ageMs: number) =>
      prisma.domainEvent.create({ data: { orgId: s.org.id, projectId: s.project.id, type, subjectId, source: "API", createdAt: new Date(Date.now() - ageMs) } });
    // Jobs weren't running: two changes from yesterday, one from a minute ago.
    await at("work_item.created", old.id, 26 * 3600_000);
    await at("work_item.transitioned", old.id, 25 * 3600_000);
    await at("work_item.created", fresh.id, 60_000);

    // The first pass skips the stale backlog and posts nothing for it.
    expect(await queueChannelDigests()).toEqual({ queued: 0, skipped: 1 });
    expect(await prisma.teamsOutbox.count({ where: { orgId: s.org.id } })).toBe(0);
    // The next posts only the fresh change.
    expect(await queueChannelDigests()).toEqual({ queued: 1, skipped: 0 });
    const f = fakeBotConnector();
    await drainTeamsOutbox({ origin: ORIGIN, deps: { fetch: f.fetch } });
    expect(f.texts()).toHaveLength(1);
    expect(f.texts()[0]).toContain("Fresh news");
    expect(f.texts()[0]).not.toContain("Old news");
    // Nothing is left over.
    expect(await queueChannelDigests()).toEqual({ queued: 0, skipped: 0 });
  });

  it("channel updates: a change just under 2 hours old is still posted", async () => {
    const s = await setup();
    await handleActivity(s.channel("alice", `link ${s.key}`) as never, ORIGIN, { fetch: fakeBotConnector().fetch });
    const item = await s.item("Recent enough", s.alice);
    await prisma.domainEvent.create({ data: { orgId: s.org.id, projectId: s.project.id, type: "work_item.created", subjectId: item.id, source: "API", createdAt: new Date(Date.now() - 2 * 3600_000 + 60_000) } });
    expect(await queueChannelDigests()).toEqual({ queued: 1, skipped: 0 });
  });
});
