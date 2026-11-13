// @vitest-environment node
//
// The org-wide Teams notifications posted to a channel everyone in the Teams
// team reads, whatever they may see in Cosmos: new and completed items and
// sprint starts from team-scoped and classified projects, titles with
// classification markings, and @-mention snippets from private channels and
// direct messages. They now follow the Teams app's channel rule. Driven through
// the real callers against a database, with the Graph post faked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown, posts: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/integrations/teams", () => ({
  postTeamsChannelMessage: async (_orgId: string, msg: { html: string }) => {
    h.posts.push(msg.html);
    return { ok: true };
  },
}));

import { runAfterCommit } from "@/lib/work-items/after-commit";
import { fanOutChatMessage } from "@/lib/chat/notifications";
import { PUT as putInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/route";
import { POST as postDigest } from "@/app/api/v1/orgs/[orgId]/integrations/teams/digest/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", ownerId = "", typeId = "";
const project: Record<"open" | "team" | "marked", { id: string; key: string }> = {} as never;
const channel: Record<"public" | "private" | "dm", string> = {} as never;

/** The posts made while `run` ran, once `marker` (a positive control run after it) has arrived. */
async function postsAround(run: () => Promise<void>, control: () => Promise<void>, marker: string): Promise<string[]> {
  await run();
  await control();
  await vi.waitFor(() => expect(h.posts.some((p) => p.includes(marker))).toBe(true), { timeout: 3000 });
  // Detached posts from `run` resolve before the control's: give stragglers a beat anyway.
  await new Promise((r) => setTimeout(r, 50));
  return [...h.posts];
}

async function complete(projectId: string, title: string) {
  const item = await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: ownerId, title, columnKey: "todo" });
  await runAfterCommit({
    orgId, projectId, actorId: ownerId, source: "API", fields: ["columnKey"], textChanged: false, columnTouched: true, assigneeId: undefined,
    items: [{
      id: item.id, ticketNumber: item.ticketNumber,
      before: { title, columnKey: "todo", assigneeId: null, completedAt: null },
      after: { title, description: "", columnKey: "done", completedAt: new Date() },
    }],
  });
}

async function mention(channelId: string, kind: "CHANNEL" | "DM", content: string) {
  const msg = await prisma.chatMessage.create({ data: { channelId, authorId: ownerId, content } });
  await fanOutChatMessage({
    orgId, channelId, channelKind: kind, channelName: null, orgSlug: `chp-${stamp}`, messageId: msg.id,
    authorId: ownerId, authorDisplayName: "Owner", content, mentionedUserIds: [ownerId],
  } as Parameters<typeof fanOutChatMessage>[0]);
}

async function startSprint(projectId: string, name: string) {
  const sprint = await prisma.interval.create({
    data: { orgId, projectId, number: Math.floor(Math.random() * 1e6), name, startDate: new Date("2026-01-01"), endDate: new Date("2026-01-14") },
  });
  const res = await putInterval(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${projectId}/intervals/${sprint.id}`, { method: "PUT", body: JSON.stringify({ status: "ACTIVE" }), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ orgId, projectId, intervalId: sprint.id }) },
  );
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `chp ${stamp}`, slug: `chp-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `owner-${stamp}@chp.test`, displayName: "Owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  const permissions = RolePermissions.OWNER;
  h.ctx = { userId: ownerId, orgId, orgRole: "OWNER", abacRules: [], basePermissions: permissions, permissions } satisfies AuthContext;
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;

  for (const [k, extra] of [["open", {}], ["team", { teamScopedAccess: true }], ["marked", {}]] as const) {
    const p = await prisma.project.create({ data: { orgId, name: `${k} project`, key: `${k[0]}${stamp}`.toUpperCase().slice(0, 7), ...extra } });
    project[k] = { id: p.id, key: p.key };
  }
  await prisma.dataClassification.create({ data: { orgId, projectId: project.marked.id, level: "CUI", appliedById: ownerId } });

  await prisma.integration.create({
    data: {
      orgId, provider: "microsoft-teams-messaging", status: "ACTIVE", installedById: ownerId,
      config: { notify: { itemCompleted: true, itemCreated: true, sprintStartEnd: true, mentions: true, feedbackDelivered: true } },
    },
  });

  const mk = async (name: string | null, kind: "CHANNEL" | "DM", isPrivate: boolean) =>
    (await prisma.chatChannel.create({ data: { orgId, kind, name, slug: name && `${name}-${stamp}`, isPrivate, createdById: ownerId, dmKey: kind === "DM" ? `dm-${stamp}` : null } })).id;
  channel.public = await mk("lobby", "CHANNEL", false);
  channel.private = await mk("hush", "CHANNEL", true);
  channel.dm = await mk(null, "DM", false);
});

afterAll(async () => {
  const channels = Object.values(channel);
  await prisma.notification.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.chatMessage.deleteMany({ where: { channelId: { in: channels } } });
  await prisma.chatChannel.deleteMany({ where: { orgId } });
  await prisma.integration.deleteMany({ where: { orgId } });
  await prisma.dataClassification.deleteMany({ where: { orgId } });
  await prisma.interval.deleteMany({ where: { orgId } });
  await prisma.workItem.deleteMany({ where: { orgId } });
  await prisma.workflowStatus.deleteMany({ where: { project: { orgId } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

beforeEach(() => {
  h.posts.length = 0;
});

describe("completed work in the Teams channel", () => {
  it("is posted for an open project, and not for a team-scoped or classified one", async () => {
    const posts = await postsAround(
      async () => {
        await complete(project.team.id, `team-only ${stamp}`);
        await complete(project.marked.id, `classified ${stamp}`);
      },
      () => complete(project.open.id, `open ${stamp}`),
      `open ${stamp}`,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(project.open.key);
  });

  it("leaves out a title that carries a marking, and keeps the reference", async () => {
    await complete(project.open.id, `CUI plan ${stamp}`);
    await vi.waitFor(() => expect(h.posts).toHaveLength(1), { timeout: 3000 });
    expect(h.posts[0]).toContain(project.open.key);
    expect(h.posts[0]).not.toContain("CUI");
    expect(h.posts[0]).not.toContain(stamp);
  });
});

describe("sprint starts in the Teams channel", () => {
  it("are posted for an open project, and not for a team-scoped one", async () => {
    const posts = await postsAround(
      () => startSprint(project.team.id, `team sprint ${stamp}`),
      () => startSprint(project.open.id, `open sprint ${stamp}`),
      `open sprint ${stamp}`,
    );
    expect(posts).toHaveLength(1);
  });
});

describe("@-mentions in the Teams channel", () => {
  it("quote a public channel, and never a private channel or a DM", async () => {
    const posts = await postsAround(
      async () => {
        await mention(channel.private.toString(), "CHANNEL", `private words ${stamp}`);
        await mention(channel.dm, "DM", `dm words ${stamp}`);
      },
      () => mention(channel.public, "CHANNEL", `public words ${stamp}`),
      `public words ${stamp}`,
    );
    expect(posts).toHaveLength(1);
    expect(posts.join(" ")).not.toContain("private words");
    expect(posts.join(" ")).not.toContain("dm words");
  });
});

describe("the daily digest in the Teams channel", () => {
  it("counts only the projects the channel may hear about", async () => {
    await prisma.integration.updateMany({
      where: { orgId },
      data: { config: { notify: { itemCompleted: true, itemCreated: true, sprintStartEnd: true, mentions: true, feedbackDelivered: true, dailyDigest: true } } },
    });
    for (const k of ["open", "team", "marked"] as const) {
      const item = await createFixtureWorkItem({ orgId, projectId: project[k].id, workItemTypeId: typeId, createdById: ownerId, title: `digest ${k} ${stamp}`, columnKey: "done" });
      await prisma.workItem.update({ where: { id: item.id }, data: { completedAt: new Date() } });
    }
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const count = (projectIds: string[], field: "createdAt" | "completedAt") =>
      prisma.workItem.count({ where: { orgId, projectId: { in: projectIds }, [field]: { gte: since } } });
    const all = Object.values(project).map((p) => p.id);
    // The owner reads all three, so the counts differ only by the channel rule.
    expect(await count(all, "completedAt")).toBeGreaterThan(await count([project.open.id], "completedAt"));

    const res = await postDigest(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/integrations/teams/digest`, { method: "POST", body: "{}" }), {
      params: Promise.resolve({ orgId }),
    });
    expect(res.status).toBe(200);
    const raw = await res.json();
    const body = (raw.data ?? raw) as { posted: boolean; completed: number; created: number };
    expect(body.posted).toBe(true);
    expect(body.completed).toBe(await count([project.open.id], "completedAt"));
    expect(body.created).toBe(await count([project.open.id], "createdAt"));
    expect(h.posts.at(-1)).toContain(`${body.completed} completed`);
  });
});
