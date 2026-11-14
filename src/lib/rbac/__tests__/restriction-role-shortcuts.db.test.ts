// @vitest-environment node
//
// An org restriction with no conditions takes its permission from every API
// key and every member except the owner's own session. A check that grants by
// ROLE never reads the permission mask, so it hands the bit straight back.
// restriction-admin-shortcut.db.test.ts pins the shortcuts inside lib/rbac;
// these pin the ones that live elsewhere: an org administrator's authority over
// other people's saved filters, their time entries, and (through the
// assistant) their comments. Each now needs the bit its role stands for, which
// owners and admins hold by role, so only a restriction makes it fail.
//
// Against a real database, through the real routes, the real executor and the
// real `getAuthContext`: only `next/headers` is stood in for, so a cookie
// request runs the session path and a bearer request runs the key path, as in
// production. Its own org and users throughout; the seeded users are shared.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { maskToDb } from "@/lib/rbac/permissions";
import { seedBoardColumns } from "@/lib/workflow/provision.server";

// The request being answered. Each call below sets it first.
const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({
    get: (name: string) => {
      const m = (h.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
      return m ? { name, value: m[1] } : undefined;
    },
  }),
}));
// getAuthContext is wrapped in React's per-request `cache`; every call here is
// its own request.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
// Writes revalidate cached lists, which needs the Next request store; outside
// Next there is nothing to revalidate.
vi.mock("next/cache", async (orig) => ({
  ...(await orig<typeof import("next/cache")>()),
  revalidateTag: () => undefined,
  updateTag: () => undefined,
}));

import { GET as getView, PATCH as patchView, DELETE as deleteView } from "@/app/api/v1/orgs/[orgId]/saved-views/[viewId]/route";
import { PUT as putEntry, DELETE as voidEntry } from "@/app/api/v1/orgs/[orgId]/time-entries/[entryId]/route";
import { DELETE as deleteItemComment } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/[commentId]/route";
import { deleteComment } from "@/lib/ai/executors/comments";
import { getAuthContext } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/client";

const stamp = Math.random().toString(36).slice(2, 8);
const slug = `rrs-${stamp}`;
let orgId = "", projectId = "", itemId = "";
const userIds: Record<"owner" | "admin" | "member", string> = { owner: "", admin: "", member: "" };

/** Who calls. Keys only where a key reaches the door: the assistant takes no key (no scope grants CHAT_USE). */
const as: Record<"ownerSession" | "adminSession" | "ownerKey" | "adminKey", Headers> = {} as never;

async function sessionFor(userId: string) {
  const id = randomBytes(24).toString("hex");
  await prisma.session.create({
    data: { id, userId, expiresAt: new Date(Date.now() + 60 * 60_000), authMethod: "password", mfaSatisfied: true },
  });
  return new Headers({ cookie: `${SESSION_COOKIE}=${id}` });
}

/** An owner's or admin's key with every scope these doors take. */
async function keyFor(userId: string) {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  await prisma.apiKey.create({
    data: {
      orgId,
      name: "restriction test",
      prefix,
      keyHash: createHash("sha256").update(secret).digest("hex"),
      scopes: ["read", "items:write", "items:delete", "time:write"],
      createdById: userId,
      projectIds: [],
    },
  });
  return new Headers({ authorization: `Bearer cosmos_${prefix}_${secret}` });
}

async function restrict(actions: string[]) {
  const actionRestrictions = actions.length ? [{ effect: "deny", actions, conditions: [] }] : [];
  await prisma.orgSecuritySettings.upsert({
    where: { orgId },
    create: { orgId, actionRestrictions },
    update: { actionRestrictions },
  });
}

function call(who: Headers, method: string, path: string, body?: unknown) {
  h.headers = who;
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/${path}`, {
    method,
    headers: who,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// ── saved filters ────────────────────────────────────────────────────────────

/** A filter the member saved, shared with the whole org so every caller here can see it. */
const memberFilter = async (name: string, visibility: "ORG" | "PRIVATE" = "ORG") =>
  (await prisma.savedView.create({
    data: { orgId, ownerId: userIds.member, name, visibility, shared: visibility === "ORG", query: { v: 1, where: null } },
    select: { id: true },
  })).id;
const viewParams = (viewId: string) => ({ params: Promise.resolve({ orgId, viewId }) });
const describeView = async (who: Headers, viewId: string, description: string) =>
  (await patchView(call(who, "PATCH", `saved-views/${viewId}`, { description }), viewParams(viewId))).status;
const removeView = async (who: Headers, viewId: string) =>
  (await deleteView(call(who, "DELETE", `saved-views/${viewId}`), viewParams(viewId))).status;
const openView = async (who: Headers, viewId: string) =>
  (await getView(call(who, "GET", `saved-views/${viewId}`), viewParams(viewId))).status;
const viewDescription = async (viewId: string) => (await prisma.savedView.findUniqueOrThrow({ where: { id: viewId } })).description;

// ── time entries ─────────────────────────────────────────────────────────────

/** A draft entry, with no project and no timesheet: open, and visible to everybody here. */
const draftEntry = async (userId: string) =>
  (await prisma.timeEntry.create({ data: { orgId, userId, date: new Date("2026-11-02"), hours: 1 }, select: { id: true } })).id;
const entryParams = (entryId: string) => ({ params: Promise.resolve({ orgId, entryId }) });
const editEntry = async (who: Headers, entryId: string, hours: number) =>
  (await putEntry(call(who, "PUT", `time-entries/${entryId}`, { hours }), entryParams(entryId))).status;
const removeEntry = async (who: Headers, entryId: string) =>
  (await voidEntry(call(who, "DELETE", `time-entries/${entryId}`, { reason: "logged twice" }), entryParams(entryId))).status;
const entry = (entryId: string) => prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });

// ── comments ─────────────────────────────────────────────────────────────────

const memberComment = async (content: string, authorId = userIds.member) =>
  (await prisma.comment.create({ data: { orgId, workItemId: itemId, authorId, content }, select: { id: true } })).id;
const commentExists = async (id: string) => (await prisma.comment.count({ where: { id } })) === 1;

/** The assistant's delete_comment, handed the caller's own AuthContext as the chat route hands it. */
async function cosmoDeletes(who: Headers, commentId: string) {
  h.headers = who;
  const auth = await getAuthContext(slug);
  expect(auth).not.toBeNull();
  return deleteComment({ commentId }, { orgId, userId: auth!.userId, auth: auth! });
}
const restDeletes = async (who: Headers, commentId: string) =>
  (await deleteItemComment(call(who, "DELETE", `projects/${projectId}/work-items/${itemId}/comments/${commentId}`), {
    params: Promise.resolve({ orgId, projectId, itemId, commentId }),
  })).status;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `rrs ${stamp}`, slug, tenantClass: "COMMERCIAL" } })).id;
  projectId = (await prisma.project.create({ data: { orgId, name: "Shortcuts", key: `RR${stamp.slice(0, 4).toUpperCase()}` } })).id;
  for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
    const who = role.toLowerCase() as keyof typeof userIds;
    const userId = (await prisma.user.create({ data: { email: `${who}-${stamp}@restriction.test`, displayName: role } })).id;
    userIds[who] = userId;
    // No stored override: the role alone is what grants.
    await prisma.orgMember.create({ data: { orgId, userId, role, permissions: maskToDb(0n) } });
  }
  as.ownerSession = await sessionFor(userIds.owner);
  as.adminSession = await sessionFor(userIds.admin);
  as.ownerKey = await keyFor(userIds.owner);
  as.adminKey = await keyFor(userIds.admin);
  const typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  // A work item needs its project's status to exist.
  const board = await prisma.board.create({ data: { orgId, projectId, name: "Board", type: "KANBAN" } });
  await prisma.$transaction((tx) => seedBoardColumns(tx, board, [{ key: "todo", name: "To Do", category: "TODO" }]));
  itemId = (await prisma.workItem.create({
    data: { orgId, projectId, ticketNumber: 1, title: "Discussed", description: "", columnKey: "todo", workItemTypeId: typeId, createdById: userIds.member },
    select: { id: true },
  })).id;
});

beforeEach(async () => {
  await restrict([]);
});

afterAll(async () => {
  const ids = Object.values(userIds).filter(Boolean);
  await prisma.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await prisma.apiKey.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.savedView.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.comment.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.workItem.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.board.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId } }).catch(() => undefined);
  // Audit rows and time-entry revisions are append-only, so the org that wrote
  // them may not be deleted.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
});

describe("someone else's saved filter: an admin's authority needs FILTER_SHARE_ORG", () => {
  it("with no restriction, an admin's session edits, opens and deletes it (control)", async () => {
    const shared = await memberFilter("shared, open");
    const priv = await memberFilter("private, open", "PRIVATE");
    expect(await describeView(as.adminSession, shared, "admin, open")).toBe(200);
    expect(await viewDescription(shared)).toBe("admin, open");
    // An administrator loads any filter, to hand it on when its owner leaves.
    expect(await openView(as.adminSession, priv)).toBe(200);
    expect(await removeView(as.adminSession, priv)).toBe(204);
  });

  it("denying FILTER_SHARE_ORG, an admin's session no longer does, and the owner's still does", async () => {
    const shared = await memberFilter("shared, restricted");
    const priv = await memberFilter("private, restricted", "PRIVATE");
    await restrict(["FILTER_SHARE_ORG"]);
    expect(await describeView(as.adminSession, shared, "admin, restricted")).toBe(403);
    expect(await removeView(as.adminSession, shared)).toBe(403);
    // A private filter is the member's again: not found, as for anyone else.
    expect(await openView(as.adminSession, priv)).toBe(404);
    expect(await describeView(as.ownerSession, shared, "owner, restricted")).toBe(200);
    expect(await viewDescription(shared)).toBe("owner, restricted");
    expect(await openView(as.ownerSession, priv)).toBe(200);
    expect(await removeView(as.ownerSession, priv)).toBe(204);
  });

  it("a key never acts as an admin here, restricted or not", async () => {
    const shared = await memberFilter("shared, keys");
    const own = (await prisma.savedView.create({
      data: { orgId, ownerId: userIds.owner, name: "the owner's own", query: { v: 1, where: null } },
      select: { id: true },
    })).id;
    expect(await describeView(as.ownerKey, own, "own, by key")).toBe(200); // the key reaches the door
    for (const key of [as.ownerKey, as.adminKey]) expect(await describeView(key, shared, "by key")).toBe(403);
    await restrict(["FILTER_SHARE_ORG"]);
    for (const key of [as.ownerKey, as.adminKey]) expect(await describeView(key, shared, "by key")).toBe(403);
    expect(await viewDescription(shared)).toBe("");
  });
});

describe("someone else's time entry: an admin's authority needs TIME_APPROVE", () => {
  it("with no restriction, an admin's session edits and removes it (control)", async () => {
    const edited = await draftEntry(userIds.member);
    const removed = await draftEntry(userIds.member);
    expect(await editEntry(as.adminSession, edited, 2)).toBe(200);
    expect((await entry(edited)).hours).toBe(2);
    expect(await removeEntry(as.adminSession, removed)).toBe(204);
    expect((await entry(removed)).voidedAt).not.toBeNull();
  });

  it("denying TIME_APPROVE, an admin's session no longer edits it, and the owner's still does", async () => {
    const theirs = await draftEntry(userIds.member);
    const own = await draftEntry(userIds.admin);
    await restrict(["TIME_APPROVE"]);
    expect(await editEntry(as.adminSession, theirs, 3)).toBe(403);
    // Still the admin's own time: the restriction took the authority over others, not TIME_UPDATE.
    expect(await editEntry(as.adminSession, own, 3)).toBe(200);
    expect(await editEntry(as.ownerSession, theirs, 4)).toBe(200);
    expect((await entry(theirs)).hours).toBe(4);
  });

  it("denying TIME_APPROVE, an admin's session no longer removes it, and the owner's still does", async () => {
    const theirs = await draftEntry(userIds.member);
    await restrict(["TIME_APPROVE"]);
    expect(await removeEntry(as.adminSession, theirs)).toBe(403);
    expect((await entry(theirs)).voidedAt).toBeNull();
    expect(await removeEntry(as.ownerSession, theirs)).toBe(204);
    expect((await entry(theirs)).voidedAt).not.toBeNull();
  });

  it("a key never acts as an admin here, restricted or not", async () => {
    const theirs = await draftEntry(userIds.member);
    const own = await draftEntry(userIds.owner);
    expect(await editEntry(as.ownerKey, own, 5)).toBe(200); // the key reaches the door
    for (const key of [as.ownerKey, as.adminKey]) expect(await editEntry(key, theirs, 6)).toBe(403);
    await restrict(["TIME_APPROVE"]);
    for (const key of [as.ownerKey, as.adminKey]) expect(await editEntry(key, theirs, 6)).toBe(403);
    expect((await entry(theirs)).hours).toBe(1);
  });
});

describe("someone else's comment, through the assistant: an admin's moderation needs ITEM_DELETE", () => {
  it("with no restriction, an admin's session deletes it, by the assistant and by the API (control)", async () => {
    const a = await memberComment("open, by the assistant");
    const b = await memberComment("open, by the API");
    expect(await cosmoDeletes(as.adminSession, a)).toMatchObject({ deleted: true });
    expect(await restDeletes(as.adminSession, b)).toBe(204);
    expect(await commentExists(a)).toBe(false);
    expect(await commentExists(b)).toBe(false);
  });

  it("denying ITEM_DELETE, an admin's session no longer deletes it through either door, and the owner's still does", async () => {
    const theirs = await memberComment("restricted");
    const own = await memberComment("the admin's own", userIds.admin);
    await restrict(["ITEM_DELETE"]);
    expect(await cosmoDeletes(as.adminSession, theirs)).toMatchObject({ error: expect.stringMatching(/author or an admin/) });
    // The API door agrees (canManageProject, since #1398).
    expect(await restDeletes(as.adminSession, theirs)).toBe(403);
    expect(await commentExists(theirs)).toBe(true);
    // Their own words are still theirs to withdraw.
    expect(await cosmoDeletes(as.adminSession, own)).toMatchObject({ deleted: true });
    expect(await cosmoDeletes(as.ownerSession, theirs)).toMatchObject({ deleted: true });
    expect(await commentExists(theirs)).toBe(false);
  });
});
