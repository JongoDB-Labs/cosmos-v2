// @vitest-environment node
//
// An org restriction with no conditions takes its permission from every API
// key and every member except the owner's own session (the owner's
// break-glass, so an owner can always undo one). Folding it out of the
// permission mask (lib/rbac/effective-permissions.ts) is not enough on its
// own: a check that grants by ROLE never reads the mask. These pin the org
// administrator shortcuts that used to hand the bit back.
//
// Against a real database, through the real routes and the real
// `getAuthContext`: only `next/headers` is stood in for, so a cookie request
// runs the session path and a bearer request runs the key path, as they do in
// production. Its own org and users throughout; the seeded users are shared.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { maskToDb } from "@/lib/rbac/permissions";

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
// Project and board writes revalidate cached lists, which needs the Next
// request store; outside Next there is nothing to revalidate.
vi.mock("next/cache", async (orig) => ({
  ...(await orig<typeof import("next/cache")>()),
  revalidateTag: () => undefined,
  updateTag: () => undefined,
}));

import { PUT as updateProject } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/route";
import { POST as createBoard } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route";
import { getAuthContext } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { getManagedProjectIds } from "@/lib/rbac/scope";

const stamp = Math.random().toString(36).slice(2, 8);
const slug = `rs-${stamp}`;
let orgId = "", projectId = "";
const userIds: string[] = [];

/** Who calls: each org administrator by session and by an `items:write` key. */
const as: Record<"ownerSession" | "adminSession" | "ownerKey" | "adminKey", Headers> = {} as never;

async function sessionFor(userId: string) {
  const id = randomBytes(24).toString("hex");
  await prisma.session.create({
    data: { id, userId, expiresAt: new Date(Date.now() + 60 * 60_000), authMethod: "password", mfaSatisfied: true },
  });
  return new Headers({ cookie: `${SESSION_COOKIE}=${id}` });
}

async function keyFor(userId: string) {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  await prisma.apiKey.create({
    data: {
      orgId,
      name: "restriction test",
      prefix,
      keyHash: createHash("sha256").update(secret).digest("hex"),
      scopes: ["items:write"],
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

const params = () => ({ params: Promise.resolve({ orgId, projectId }) });

async function rename(who: Headers, name: string) {
  h.headers = who;
  const req = new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${projectId}`, {
    method: "PUT",
    headers: who,
    body: JSON.stringify({ name }),
  });
  return (await updateProject(req, params())).status;
}

async function addBoard(who: Headers, name: string) {
  h.headers = who;
  const req = new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${projectId}/boards`, {
    method: "POST",
    headers: who,
    body: JSON.stringify({ name }),
  });
  return (await createBoard(req, params())).status;
}

/** The projects the org-wide Issues view offers manage actions on. */
async function managed(who: Headers) {
  h.headers = who;
  const ctx = await getAuthContext(slug);
  expect(ctx).not.toBeNull();
  return [...(await getManagedProjectIds(ctx!, [projectId]))];
}

const projectName = async () => (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).name;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `rs ${stamp}`, slug, tenantClass: "COMMERCIAL" } })).id;
  projectId = (await prisma.project.create({ data: { orgId, name: "Before", key: `RS${stamp.slice(0, 4).toUpperCase()}` } })).id;
  for (const role of ["OWNER", "ADMIN"] as const) {
    const userId = (await prisma.user.create({ data: { email: `${role.toLowerCase()}-${stamp}@restriction.test`, displayName: role } })).id;
    userIds.push(userId);
    // No stored override: the role alone is what grants.
    await prisma.orgMember.create({ data: { orgId, userId, role, permissions: maskToDb(0n) } });
    const who = role === "OWNER" ? "owner" : "admin";
    as[`${who}Session`] = await sessionFor(userId);
    as[`${who}Key`] = await keyFor(userId);
  }
});

beforeEach(async () => {
  await restrict([]);
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await prisma.apiKey.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.board.deleteMany({ where: { projectId } }).catch(() => undefined);
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId } }).catch(() => undefined);
  // Audit rows are append-only, so the org that wrote them may not be deleted.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe("an unconditional restriction holds against an org administrator's role", () => {
  it("with no restriction, all four rename the project (control)", async () => {
    expect(await rename(as.ownerSession, "Owner session")).toBe(200);
    expect(await rename(as.adminSession, "Admin session")).toBe(200);
    expect(await rename(as.ownerKey, "Owner key")).toBe(200);
    expect(await rename(as.adminKey, "Admin key")).toBe(200);
    expect(await projectName()).toBe("Admin key");
  });

  it("denying PROJECT_UPDATE, only the owner's own session still renames it", async () => {
    await restrict(["PROJECT_UPDATE"]);
    expect(await rename(as.ownerSession, "Owner, restricted")).toBe(200);
    expect(await rename(as.adminSession, "Admin session, restricted")).toBe(403);
    expect(await rename(as.ownerKey, "Owner key, restricted")).toBe(403);
    expect(await rename(as.adminKey, "Admin key, restricted")).toBe(403);
    expect(await projectName()).toBe("Owner, restricted");
  });

  it("the Issues view offers the manage actions only where the route allows them", async () => {
    for (const who of Object.values(as)) expect(await managed(who)).toEqual([projectId]); // control
    await restrict(["PROJECT_UPDATE"]);
    expect(await managed(as.ownerSession)).toEqual([projectId]);
    expect(await managed(as.adminSession)).toEqual([]);
    expect(await managed(as.ownerKey)).toEqual([]);
    expect(await managed(as.adminKey)).toEqual([]);
  });

  it("denying BOARD_CREATE, an admin's session no longer creates a board, and the owner's still does", async () => {
    expect(await addBoard(as.adminSession, "Admin, open")).toBe(201); // control
    await restrict(["BOARD_CREATE"]);
    expect(await addBoard(as.ownerSession, "Owner, restricted")).toBe(201);
    expect(await addBoard(as.adminSession, "Admin, restricted")).toBe(403);
    const names = (await prisma.board.findMany({ where: { projectId }, select: { name: true } })).map((b) => b.name);
    expect(names.sort()).toEqual(["Admin, open", "Owner, restricted"]);
  });
});
