// @vitest-environment node
//
// COSMOS-216/217: the notification feed's writes and its preview, against the
// real routes and a real database. Two people in one org:
//   - clearing, one at a time or all at once, never touches the other's;
//   - the preview reads its work item through the row endpoint, which answers
//     404 for an item in a project the reader can't see — so a notification
//     about such an item previews as nothing.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { seedBoardColumns } from "@/lib/workflow/provision.server";

const calls = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));

import { POST as inboxPost } from "@/app/api/v1/orgs/[orgId]/notifications/inbox/route";
import {
  PUT as notificationPut,
  DELETE as notificationDelete,
} from "@/app/api/v1/orgs/[orgId]/notifications/[notificationId]/route";
import { GET as rowGet } from "@/app/api/v1/orgs/[orgId]/work-items/[itemId]/row/route";

let orgId = "";
let aliceId = "";
let bobId = "";
let openItemId = "";
let secretItemId = "";

const MEMBER =
  Permission.NOTIFICATION_READ | Permission.ITEM_READ | Permission.PROJECT_READ | Permission.ORG_READ;

function actAs(userId: string, role: OrgRole = OrgRole.MEMBER) {
  calls.ctx = {
    userId, orgId, orgRole: role, permissions: MEMBER, basePermissions: MEMBER, abacRules: [],
  } satisfies AuthContext;
}

const params = () => Promise.resolve({ orgId });
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/orgs/o/notifications/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function seed(userId: string, n: number, over: { type?: string; read?: boolean } = {}) {
  await prisma.notification.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      orgId, userId, type: over.type ?? "work_item.assigned", title: `n${i}`, read: over.read ?? false,
    })),
  });
}
const countFor = (userId: string) => prisma.notification.count({ where: { orgId, userId } });

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  bobId = (await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `notif ${stamp}`, slug: `notif-${stamp}` } })).id;
  const [aliceMember] = await Promise.all([
    prisma.orgMember.create({ data: { orgId, userId: aliceId, role: "MEMBER" } }),
    prisma.orgMember.create({ data: { orgId, userId: bobId, role: "MEMBER" } }),
  ]);
  const typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  const open = await prisma.project.create({ data: { orgId, name: "Open", key: `OP${stamp.slice(-4)}`.toUpperCase().replace(/[^A-Z0-9]/g, "X") } });
  // Team-scoped, and only alice is on it.
  const secret = await prisma.project.create({
    data: { orgId, name: "Secret", key: `SE${stamp.slice(-4)}`.toUpperCase().replace(/[^A-Z0-9]/g, "X"), teamScopedAccess: true },
  });
  await prisma.projectMember.create({ data: { projectId: secret.id, orgMemberId: aliceMember.id } });
  // Work items need their project's status to exist.
  for (const p of [open, secret]) {
    const board = await prisma.board.create({ data: { orgId, projectId: p.id, name: "Board", type: "KANBAN" } });
    await prisma.$transaction((tx) => seedBoardColumns(tx, board, [{ key: "todo", name: "To Do", category: "TODO" }]));
  }
  const mk = (projectId: string, title: string, ticketNumber: number) =>
    prisma.workItem.create({
      data: { orgId, projectId, ticketNumber, title, description: "", columnKey: "todo", workItemTypeId: typeId, createdById: aliceId },
    });
  openItemId = (await mk(open.id, "Open item", 1)).id;
  secretItemId = (await mk(secret.id, "Secret item", 1)).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { orgId } });
  actAs(aliceId);
});

describe("clearing never reaches another person's notifications", () => {
  it("clear all removes the caller's and leaves the other's", async () => {
    await seed(aliceId, 3);
    await seed(bobId, 4);
    const res = await inboxPost(post({ action: "clear" }), { params: params() });
    expect(await res.json()).toEqual({ cleared: 3 });
    expect(await countFor(aliceId)).toBe(0);
    expect(await countFor(bobId)).toBe(4);
  });

  it("a kind, unread only, clears just that slice of the caller's", async () => {
    await seed(aliceId, 2, { type: "comment.mentioned" });
    await seed(aliceId, 1, { type: "comment.mentioned", read: true });
    await seed(aliceId, 2, { type: "work_item.assigned" });
    await seed(bobId, 2, { type: "comment.mentioned" });
    const res = await inboxPost(post({ action: "clear", type: "comment.mentioned", unreadOnly: true }), { params: params() });
    expect(await res.json()).toEqual({ cleared: 2 });
    expect(await countFor(aliceId)).toBe(3);
    expect(await countFor(bobId)).toBe(2);
  });

  it("clearing or marking someone else's single notification is a 404, and changes nothing", async () => {
    await seed(bobId, 1);
    const bobs = await prisma.notification.findFirstOrThrow({ where: { orgId, userId: bobId } });
    const p = { params: Promise.resolve({ orgId, notificationId: bobs.id }) };
    const del = await notificationDelete(new NextRequest("http://localhost/x", { method: "DELETE" }), p);
    expect(del.status).toBe(404);
    const put = await notificationPut(
      new NextRequest("http://localhost/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read: true }),
      }),
      { params: Promise.resolve({ orgId, notificationId: bobs.id }) },
    );
    expect(put.status).toBe(404);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: bobs.id } })).toMatchObject({ read: false });
  });
});

describe("the preview's item read shows only what the reader can open", () => {
  const row = async (itemId: string) =>
    rowGet(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ orgId, itemId }) });

  it("returns an item in a project the reader can see", async () => {
    actAs(bobId);
    const res = await row(openItemId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: openItemId, title: "Open item" });
  });

  it("is a 404, with nothing of the item, for one in a project the reader isn't on", async () => {
    actAs(bobId);
    const res = await row(secretItemId);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Secret item");
  });

  it("returns the same item to someone on that project", async () => {
    actAs(aliceId);
    const res = await row(secretItemId);
    expect(res.status).toBe(200);
  });
});
