// @vitest-environment node
//
// GET /api/v1/orgs/{orgId} returned the org's member list (with every email),
// its projects and its settings without authenticating anyone. The proxy lets
// any `Bearer cosmos_…` header through to the route so the route can judge the
// key, and this handler never asked. These specs pin that it now asks, and
// that what it returns is cut to what the caller may see.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", ownerId = "", memberId = "", openProjectId = "", teamProjectId = "";

const at = () => ({ params: Promise.resolve({ orgId }) });
const req = () =>
  new NextRequest(`http://localhost/api/v1/orgs/${orgId}`, {
    headers: { authorization: "Bearer cosmos_000000000000_notarealkey" },
  });

function ctxFor(userId: string, role: "OWNER" | "MEMBER", extra: Partial<AuthContext> = {}): AuthContext {
  const permissions = RolePermissions[role];
  return { userId, orgId, orgRole: role, abacRules: [], basePermissions: permissions, permissions, ...extra };
}

type Body = {
  id: string;
  settings?: unknown;
  members: Array<{ user: { id: string; email?: string } }>;
  projects: Array<{ id: string }>;
};
const read = async (res: Response) => {
  const json = await res.json();
  return (json.data ?? json) as Body;
};

beforeAll(async () => {
  orgId = (await prisma.organization.create({
    data: { name: `oga ${stamp}`, slug: `oga-${stamp}`, settings: { marker: stamp } },
  })).id;
  ownerId = (await prisma.user.create({ data: { email: `owner-${stamp}@oga.test`, displayName: "Owner" } })).id;
  memberId = (await prisma.user.create({ data: { email: `member-${stamp}@oga.test`, displayName: "Member" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  const memberRow = await prisma.orgMember.create({ data: { orgId, userId: memberId, role: "MEMBER", permissions: "0" } });
  openProjectId = (await prisma.project.create({ data: { orgId, name: "Open", key: `O${stamp}`.slice(0, 6).toUpperCase() } })).id;
  // The member works on the open project; the owner is on no project.
  await prisma.projectMember.create({ data: { projectId: openProjectId, orgMemberId: memberRow.id } });
  teamProjectId = (await prisma.project.create({ data: { orgId, name: "Team only", key: `T${stamp}`.slice(0, 6).toUpperCase() } })).id;
});

afterAll(async () => {
  await prisma.projectMember.deleteMany({ where: { project: { orgId } } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
});

describe("GET /api/v1/orgs/{orgId} authenticates", () => {
  it("refuses a request with no valid session or key (401), and leaks nothing", async () => {
    h.ctx = null;
    const res = await GET(req(), at());
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("@oga.test");
    expect(text).not.toContain(stamp);
  });

  it("serves a signed-in member: members and projects, but not the org settings", async () => {
    h.ctx = ctxFor(memberId, "MEMBER");
    const res = await GET(req(), at());
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.id).toBe(orgId);
    expect(body.members.map((m) => m.user.id).sort()).toEqual([memberId, ownerId].sort());
    expect(body.members.every((m) => typeof m.user.email === "string")).toBe(true);
    expect(body.projects.map((p) => p.id)).toContain(openProjectId);
    expect(body.settings).toBeUndefined();
  });

  it("gives the settings to someone who may change them", async () => {
    h.ctx = ctxFor(ownerId, "OWNER");
    const body = await read(await GET(req(), at()));
    expect(body.settings).toEqual({ marker: stamp });
  });

  it("withholds emails from an API key without members:read, and gives them with it", async () => {
    h.ctx = ctxFor(memberId, "MEMBER", { isApiKey: true, scopes: ["read"] });
    const without = await read(await GET(req(), at()));
    expect(without.members).toHaveLength(2);
    expect(without.members.some((m) => m.user.email !== undefined)).toBe(false);

    h.ctx = ctxFor(memberId, "MEMBER", { isApiKey: true, scopes: ["read", "members:read"] });
    const withScope = await read(await GET(req(), at()));
    expect(withScope.members.every((m) => typeof m.user.email === "string")).toBe(true);
  });

  it("lists only projects inside a key's project ceiling", async () => {
    h.ctx = ctxFor(memberId, "MEMBER", { isApiKey: true, scopes: ["read"], projectScope: [openProjectId] });
    const body = await read(await GET(req(), at()));
    expect(body.projects.map((p) => p.id)).toEqual([openProjectId]);
    expect(body.projects.map((p) => p.id)).not.toContain(teamProjectId);
  });

  it("lists only the members inside a project-scoped key's roster", async () => {
    // The same roster ceiling the members endpoint applies: a key limited to
    // some projects sees the people on those projects, not the whole org.
    h.ctx = ctxFor(memberId, "MEMBER", { isApiKey: true, scopes: ["read", "members:read"], projectScope: [openProjectId] });
    const body = await read(await GET(req(), at()));
    expect(body.members.map((m) => m.user.id)).toEqual([memberId]);

    // Positive control: the same key without a project ceiling sees everyone.
    h.ctx = ctxFor(memberId, "MEMBER", { isApiKey: true, scopes: ["read", "members:read"] });
    const orgWide = await read(await GET(req(), at()));
    expect(orgWide.members.map((m) => m.user.id).sort()).toEqual([memberId, ownerId].sort());
  });

  it("refuses a caller without ORG_READ (403)", async () => {
    h.ctx = { ...ctxFor(memberId, "MEMBER"), permissions: Permission.ITEM_READ };
    const res = await GET(req(), at());
    expect(res.status).toBe(403);
  });
});
