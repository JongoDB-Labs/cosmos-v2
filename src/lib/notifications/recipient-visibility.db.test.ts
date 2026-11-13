// @vitest-environment node
//
// A notification about a work item or a program-management (PM register)
// item reaches only people who can read that item, judged as the RECIPIENT,
// with the same check the item's own page makes (its permission, any policy
// that denies it, and the project's team scoping), on every channel at once:
// the bell (the notification row), live updates, web push, Teams and Slack.
// Driven through the real routes that notify: a work-item comment that
// @mentions, an assignment, and a PM-register comment that @mentions. The
// positive control on each: a member who can read it, in the same request,
// gets everything. When the item can't be told, nothing is sent, and a check
// that fails is logged.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown, pushed: [] as string[], teams: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/notifications/push", () => ({
  pushToUser: async (userId: string) => {
    h.pushed.push(userId);
  },
}));
// Teams is counted where the notification hands it over, not by its outbox
// rows: other test files drain the Teams outbox for every org on the shared
// database, and that drain deletes the conversations of an org with no Teams
// tenant (like this one) while these tests run. The real queue still runs.
vi.mock("@/lib/integrations/microsoft/teams-app/outbox.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/integrations/microsoft/teams-app/outbox.server")>();
  return {
    ...real,
    queueTeamsNotification: async (n: Parameters<typeof real.queueTeamsNotification>[0]) => {
      if (n.relatedType === "work_item") h.teams.push(n.userId);
      return real.queueTeamsNotification(n);
    },
  };
});

const { POST: comment } = await import("@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/route");
const { PATCH: patchItem } = await import("@/app/api/v1/orgs/[orgId]/work-items/[itemId]/route");
const { POST: pmComment } = await import("@/app/api/v1/orgs/[orgId]/projects/[projectId]/pm-comments/route");
const { getBus } = await import("@/lib/realtime/bus");
const { createNotification } = await import("@/lib/notifications/create");
const { topics } = await import("@/lib/realtime/topics");

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", openProjectId = "", typeId = "";
let owner = "", insider = "", outsider = "";
const users: string[] = [];
const published: string[] = [];

beforeAll(async () => {
  const mk = async (n: string) => {
    const u = await prisma.user.create({ data: { email: `${n}-${stamp}@vis.test`, displayName: n } });
    users.push(u.id);
    return u.id;
  };
  [owner, insider, outsider] = await Promise.all(["owner", "insider", "outsider"].map(mk));
  orgId = (await prisma.organization.create({ data: { name: `vis ${stamp}`, slug: `vis-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  const insiderMember = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });

  const key = `VS${stamp.slice(0, 3).toUpperCase()}`;
  projectId = (await prisma.project.create({ data: { orgId, name: "Restricted", key, teamScopedAccess: true } })).id;
  openProjectId = (await prisma.project.create({ data: { orgId, name: "Open", key: `${key}O` } })).id;
  await prisma.projectMember.create({ data: { projectId, orgMemberId: insiderMember.id } });
  await ensureFixtureStatuses(projectId);
  await ensureFixtureStatuses(openProjectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;

  // Every channel switched on for both members: Teams chats that take
  // assignments and mentions, and Slack connected for the org.
  for (const [userId, n] of [[insider, "in"], [outsider, "out"]] as const) {
    await prisma.teamsConversation.create({
      data: { orgId, userId, tenantId: "t", serviceUrl: "https://smba.example/", conversationId: `a:${n}-${stamp}`, notifyTypes: ["assigned", "mentioned"] },
    });
  }
  await prisma.slackInstallation.create({
    data: { orgId, teamId: `T${stamp.toUpperCase()}`, teamName: "W", scopes: [], installedById: owner, publicOrigin: "https://cosmos.example.com" },
  });

  const bus = getBus();
  const real = bus.publish.bind(bus);
  vi.spyOn(bus, "publish").mockImplementation(async (topic, type, data) => {
    published.push(topic);
    return real(topic, type, data);
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

beforeEach(async () => {
  h.ctx = { userId: owner, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] } satisfies AuthContext;
  h.pushed.length = 0;
  h.teams.length = 0;
  published.length = 0;
  await prisma.notification.deleteMany({ where: { orgId } });
  await prisma.teamsOutbox.deleteMany({ where: { orgId } });
  await prisma.slackOutbox.deleteMany({ where: { orgId } });
});

const item = (pid = projectId) =>
  createFixtureWorkItem({ orgId, projectId: pid, workItemTypeId: typeId, createdById: owner, title: "Hidden roadmap", columnKey: "todo" });
const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

/** Everything that reached `userId`, on every channel. */
async function reached(userId: string) {
  return {
    bell: await prisma.notification.count({ where: { orgId, userId } }),
    live: published.filter((t) => t === topics.user(userId)).length,
    push: h.pushed.filter((u) => u === userId).length,
    teams: h.teams.filter((u) => u === userId).length,
    slack: await prisma.slackOutbox.count({ where: { orgId, userId } }),
  };
}
/** Another org member, with a role and any policy, and every channel switched on. */
async function member(name: string, role: string, abacRules: unknown[] = []) {
  const u = await prisma.user.create({ data: { email: `${name}-${stamp}@vis.test`, displayName: name } });
  users.push(u.id);
  await prisma.orgMember.create({ data: { orgId, userId: u.id, role: role as "MEMBER", permissions: "0", abacRules: abacRules as never } });
  await prisma.teamsConversation.create({
    data: { orgId, userId: u.id, tenantId: "t", serviceUrl: "https://smba.example/", conversationId: `a:${name}-${stamp}`, notifyTypes: ["assigned", "mentioned"] },
  });
  return u.id;
}
const NOTHING = { bell: 0, live: 0, push: 0, teams: 0, slack: 0 };
const ONCE = { bell: 1, live: 1, push: 1, teams: 1, slack: 1 };

describe("notifications about a team-scoped project (e2e DB)", () => {
  it("an @mention in a work-item comment reaches the member on the project, and nobody outside it", async () => {
    const it1 = await item();
    const res = await comment(json("POST", { content: `<@${insider}> and <@${outsider}>, look` }), {
      params: Promise.resolve({ orgId, projectId, itemId: it1.id }),
    });
    expect(res.status).toBe(201);
    expect(await reached(insider)).toEqual(ONCE);
    expect(await reached(outsider)).toEqual(NOTHING);
  });

  it("an assignment reaches nobody outside the project; the same assignment to a member reaches them", async () => {
    const a = await item();
    expect((await patchItem(json("PATCH", { assigneeId: outsider }), { params: Promise.resolve({ orgId, itemId: a.id }) })).status).toBe(200);
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: a.id }, select: { assigneeId: true } })).toEqual({ assigneeId: outsider });
    expect(await reached(outsider)).toEqual(NOTHING);

    const b = await item();
    expect((await patchItem(json("PATCH", { assigneeId: insider }), { params: Promise.resolve({ orgId, itemId: b.id }) })).status).toBe(200);
    expect(await reached(insider)).toEqual(ONCE);
  });

  it("an @mention on a PM register item reaches the member on the project, and nobody outside it", async () => {
    const res = await pmComment(json("POST", { subjectType: "project", subjectId: projectId, content: `<@${insider}> <@${outsider}>` }), {
      params: Promise.resolve({ orgId, projectId }),
    });
    expect(res.status).toBe(201);
    // PM comments aren't work items, so Teams and Slack don't carry them; the bell, live and push do.
    expect(await reached(insider)).toEqual({ ...NOTHING, bell: 1, live: 1, push: 1 });
    expect(await reached(outsider)).toEqual(NOTHING);
  });

  it("in a project open to everyone, the same mention reaches both", async () => {
    const open = await item(openProjectId);
    const res = await comment(json("POST", { content: `<@${insider}> <@${outsider}>` }), {
      params: Promise.resolve({ orgId, projectId: openProjectId, itemId: open.id }),
    });
    expect(res.status).toBe(201);
    expect(await reached(insider)).toEqual(ONCE);
    expect(await reached(outsider)).toEqual(ONCE);
  });

  it("someone added to the project starts hearing about it", async () => {
    const x = await item();
    const m = await prisma.orgMember.findFirstOrThrow({ where: { orgId, userId: outsider } });
    await prisma.projectMember.create({ data: { projectId, orgMemberId: m.id } });
    try {
      await comment(json("POST", { content: `<@${outsider}>` }), { params: Promise.resolve({ orgId, projectId, itemId: x.id }) });
      expect(await reached(outsider)).toEqual(ONCE);
    } finally {
      await prisma.projectMember.deleteMany({ where: { projectId, orgMemberId: m.id } });
    }
  });

  it("someone a policy forbids reading a project's items hears nothing about them, on any channel", async () => {
    const denied = await member("denied", "MEMBER", [
      { effect: "deny", actions: ["ITEM_READ"], conditions: [{ attr: "projectId", op: "eq", value: openProjectId }] },
    ]);
    const x = await item(openProjectId);
    const res = await comment(json("POST", { content: `<@${denied}> <@${insider}> the plan` }), {
      params: Promise.resolve({ orgId, projectId: openProjectId, itemId: x.id }),
    });
    expect(res.status).toBe(201);
    expect(await reached(insider)).toEqual(ONCE);
    expect(await reached(denied)).toEqual(NOTHING);
  });

  it("someone whose role can't read work items (a billing admin) hears nothing about one, even in an open project", async () => {
    const billing = await member("billing", "BILLING_ADMIN");
    const x = await item(openProjectId);
    await comment(json("POST", { content: `<@${billing}> <@${insider}>` }), { params: Promise.resolve({ orgId, projectId: openProjectId, itemId: x.id }) });
    expect(await reached(insider)).toEqual(ONCE);
    expect(await reached(billing)).toEqual(NOTHING);
  });

  it("a PM register mention reaches only people who can read that register item (a guest can't read the project's page)", async () => {
    const guest = await member("guest", "GUEST");
    const res = await pmComment(json("POST", { subjectType: "project", subjectId: openProjectId, content: `<@${guest}> <@${insider}>` }), {
      params: Promise.resolve({ orgId, projectId: openProjectId }),
    });
    expect(res.status).toBe(201);
    expect(await reached(insider)).toEqual({ ...NOTHING, bell: 1, live: 1, push: 1 });
    expect(await reached(guest)).toEqual(NOTHING);
  });

  it("sends nothing when it can't tell which item it's about, and logs the caller's mistake", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = { orgId, userId: insider, type: "comment.mentioned", title: "Mentioned" };
    // A PM register item with no project named,
    expect(await createNotification({ ...base, relatedType: "pm_risk", relatedId: crypto.randomUUID() })).toBeNull();
    // one naming a project that doesn't exist,
    expect(await createNotification({ ...base, relatedType: "pm_project", relatedId: openProjectId, projectId: crypto.randomUUID() })).toBeNull();
    // one that isn't in the project it names (one the recipient can see),
    expect(await createNotification({ ...base, relatedType: "pm_project", relatedId: openProjectId, projectId })).toBeNull();
    // and a work item with no id, or one that isn't there.
    expect(await createNotification({ ...base, relatedType: "work_item" })).toBeNull();
    expect(await createNotification({ ...base, relatedType: "work_item", relatedId: crypto.randomUUID() })).toBeNull();
    expect(await reached(insider)).toEqual(NOTHING);
    expect(warned.mock.calls.flat().join(" ")).toMatch(/pm_risk.*no project/);
    // Positive control: the same call, complete, goes through.
    expect(await createNotification({ ...base, relatedType: "pm_project", relatedId: projectId, projectId })).not.toBeNull();
    warned.mockRestore();
  });

  it("a check that fails sends nothing and is logged, never swallowed by a caller", async () => {
    const x = await item(openProjectId);
    const failed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = vi.spyOn(prisma.workItem, "findFirst").mockRejectedValueOnce(new Error("database went away"));
    expect(
      await createNotification({ orgId, userId: insider, type: "work_item.assigned", title: "Assigned", relatedType: "work_item", relatedId: x.id }),
    ).toBeNull();
    expect(db).toHaveBeenCalled();
    expect(failed.mock.calls.flat().join(" ")).toContain("database went away");
    expect(await reached(insider)).toEqual(NOTHING);
    db.mockRestore();
    failed.mockRestore();
  });
});
