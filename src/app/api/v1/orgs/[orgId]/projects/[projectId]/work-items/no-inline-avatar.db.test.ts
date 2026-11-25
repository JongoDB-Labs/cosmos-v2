// @vitest-environment node
//
// Slow initial board load: the board's work-items list inlined each
// assignee's `data:` avatar on every row. A few users with avatars, assigned
// to hundreds of items, made the list most of 16 MB, and base64 does not
// compress. The list must carry a URL to the avatar endpoint instead, and
// that URL must actually serve the image to everyone who can read the list.
//
// Against a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import { noisePngDataUri } from "@/lib/users/__tests__/noise-png";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET } from "./route";
import { GET as getAvatar } from "../../../users/[userId]/avatar/route";

const stamp = Math.random().toString(36).slice(2, 8);
const HOLDER_PNG = noisePngDataUri(64);
const LEAVER_PNG = noisePngDataUri(64);
const ITEMS = 6;

let orgId = "", projectId = "", holder = "", leaver = "", viewer = "";

const session = (): AuthContext => ({
  userId: viewer, orgId, orgRole: OrgRole.ADMIN, abacRules: [],
  permissions: RolePermissions.ADMIN, basePermissions: RolePermissions.ADMIN,
});
const projectKey = (): AuthContext => ({
  ...session(),
  orgRole: OrgRole.OWNER,
  permissions: Permission.PROJECT_READ | Permission.ITEM_READ,
  basePermissions: Permission.PROJECT_READ | Permission.ITEM_READ,
  isApiKey: true,
  scopes: ["read"],
  projectScope: [projectId],
});

async function list(): Promise<{ text: string; users: Array<{ id: string; avatarUrl: string | null }> }> {
  h.ctx = session();
  const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${projectId}/work-items`), {
    params: Promise.resolve({ orgId, projectId }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const body = JSON.parse(text);
  const rows = (body.data ?? body) as Array<{ assignees: Array<{ user: { id: string; avatarUrl: string | null } }> }>;
  return { text, users: rows.flatMap((r) => r.assignees.map((a) => a.user)) };
}

/** Follow an emitted `avatarUrl` through the real avatar route, as `ctx`. */
async function follow(src: string, ctx: AuthContext): Promise<Response> {
  const m = /^\/api\/v1\/orgs\/([^/]+)\/users\/([^/]+)\/avatar\?v=[0-9a-f]+$/.exec(src);
  expect(m, src).not.toBeNull();
  h.ctx = ctx;
  return getAvatar(new NextRequest(`http://localhost${src}`), { params: Promise.resolve({ orgId: m![1], userId: m![2] }) });
}

const bytesOf = (dataUri: string) => Buffer.from(dataUri.split(",")[1], "base64");

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `wia ${stamp}`, slug: `wia-${stamp}` } })).id;
  const mk = async (name: string, avatarUrl: string | null) =>
    (await prisma.user.create({ data: { email: `${name}-${stamp}@wia.test`, displayName: name, avatarUrl } })).id;
  holder = await mk("holder", HOLDER_PNG);
  leaver = await mk("leaver", LEAVER_PNG);
  viewer = await mk("viewer", null);
  for (const userId of [holder, viewer]) {
    await prisma.orgMember.create({ data: { orgId, userId, role: userId === viewer ? "ADMIN" : "MEMBER", permissions: "0" } });
  }
  // Removed since: their face is still on the items they were assigned.
  await prismaUnfiltered.orgMember.create({
    data: { orgId, userId: leaver, role: "MEMBER", permissions: "0", removedAt: new Date() },
  });
  projectId = (await prisma.project.create({ data: { orgId, name: `wia ${stamp}`, key: `WI${stamp.slice(0, 4).toUpperCase()}` } })).id;
  const typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  await prisma.workflowStatus.create({ data: { orgId, projectId, key: "todo", name: "To Do", category: "TODO" } });
  for (let n = 1; n <= ITEMS; n++) {
    const item = await prisma.workItem.create({
      data: { orgId, projectId, workItemTypeId: typeId, createdById: viewer, title: `item ${n}`, description: "", columnKey: "todo", ticketNumber: n },
    });
    await prisma.workItemAssignee.create({ data: { workItemId: item.id, userId: holder, sortOrder: 0 } });
    if (n === 1) await prisma.workItemAssignee.create({ data: { workItemId: item.id, userId: leaver, sortOrder: 1 } });
  }
});

afterAll(async () => {
  await prisma.workItem.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prisma.workItemType.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [holder, leaver, viewer] } } }).catch(() => undefined);
});

describe("the board's work-items list does not inline avatar bytes", () => {
  it("sends each assignee a URL to their own avatar, never the data: URI", async () => {
    const { text, users } = await list();
    expect(text).not.toContain("data:");
    expect(text).not.toContain("base64");

    const holderSrcs = users.filter((u) => u.id === holder).map((u) => u.avatarUrl);
    expect(holderSrcs).toHaveLength(ITEMS);
    for (const src of holderSrcs) {
      expect(src).toMatch(new RegExp(`^/api/v1/orgs/${orgId}/users/${holder}/avatar\\?v=[0-9a-f]+$`));
    }
    expect(users.find((u) => u.id === leaver)?.avatarUrl).toMatch(
      new RegExp(`^/api/v1/orgs/${orgId}/users/${leaver}/avatar\\?v=[0-9a-f]+$`),
    );
  });

  it("does not grow with items x avatar size: the whole list weighs less than one avatar", async () => {
    const { text } = await list();
    expect(text.length).toBeLessThan(HOLDER_PNG.length);
  });

  it("points at a URL that serves the original image to a session user", async () => {
    const { users } = await list();
    const res = await follow(users.find((u) => u.id === holder)!.avatarUrl!, session());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(bytesOf(HOLDER_PNG))).toBe(true);
  });

  it("serves it to a project-scoped API key that can read this list", async () => {
    const { users } = await list();
    const res = await follow(users.find((u) => u.id === holder)!.avatarUrl!, projectKey());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(bytesOf(HOLDER_PNG))).toBe(true);
  });

  it("serves a removed member's avatar, which is still on their items", async () => {
    const { users } = await list();
    const src = users.find((u) => u.id === leaver)!.avatarUrl!;
    for (const ctx of [session(), projectKey()]) {
      const res = await follow(src, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await res.arrayBuffer()).equals(bytesOf(LEAVER_PNG))).toBe(true);
    }
  });
});
