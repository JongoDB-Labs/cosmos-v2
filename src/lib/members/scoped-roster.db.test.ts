// @vitest-environment node
//
// A project-scoped API key sees only the people on its projects in the member
// roster (the member list and the work-item filters' members): their project
// members, and the assignees, creators and commenters of their items (ops'
// decision on the #1144 follow-up: scopes narrow). Org-wide keys and browser
// sessions see everyone. Against a real database, through the real routes.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { scopeMask } from "@/lib/auth/api-key";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx }));

import { scopedRosterUserIds } from "./scoped-roster.server";
import { GET as listMembers } from "@/app/api/v1/orgs/[orgId]/members/route";
import { GET as facets } from "@/app/api/v1/orgs/[orgId]/work-items/facets/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", p1 = "", p2 = "";
const u: Record<"owner" | "a" | "b" | "c" | "d" | "e" | "f", string> = { owner: "", a: "", b: "", c: "", d: "", e: "", f: "" };

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `roster ${stamp}`, slug: `roster-${stamp}` } })).id;
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@roster.test`, displayName: `${k.toUpperCase()} ${stamp}` } })).id;
    await prisma.orgMember.create({ data: { orgId, userId: u[k], role: k === "owner" ? "OWNER" : "MEMBER", permissions: "0" } });
  }
  p1 = (await prisma.project.create({ data: { orgId, name: "P1", key: `RA${stamp.slice(0, 3).toUpperCase()}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId, name: "P2", key: `RB${stamp.slice(0, 3).toUpperCase()}` } })).id;
  const typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
  const memberA = await prisma.orgMember.findFirstOrThrow({ where: { orgId, userId: u.a } });
  await prisma.projectMember.create({ data: { projectId: p1, orgMemberId: memberA.id } });
  const item = await createFixtureWorkItem({ orgId, projectId: p1, workItemTypeId: typeId, createdById: u.c, title: "t", columnKey: "todo" });
  await prisma.workItemAssignee.create({ data: { workItemId: item.id, userId: u.b } });
  await prisma.comment.create({ data: { orgId, workItemId: item.id, authorId: u.d, content: "hi" } });
  await createFixtureWorkItem({ orgId, projectId: p2, workItemTypeId: typeId, createdById: u.e, title: "t", columnKey: "todo" });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } }).catch(() => undefined);
});

/** The org owner's key, scoped to `projects` (none: org-wide), or the owner's browser session. */
const key = (projects?: string[]): AuthContext => ({
  userId: u.owner, orgId, orgRole: "OWNER", permissions: scopeMask(["read"]), basePermissions: scopeMask(["read"]),
  abacRules: [], isApiKey: true, scopes: ["read"], ...(projects ? { projectScope: projects } : {}),
});
const session = (): AuthContext => ({ userId: u.owner, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] });

const memberIds = async (ctx: AuthContext) => {
  h.ctx = ctx;
  const res = await listMembers(new NextRequest(`http://localhost/x?limit=100`), { params: Promise.resolve({ orgId }) });
  expect(res.status).toBe(200);
  return new Set(((await res.json()) as { userId: string }[]).map((m) => m.userId));
};
const facetMemberIds = async (ctx: AuthContext) => {
  h.ctx = ctx;
  const res = await facets(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId }) });
  expect(res.status).toBe(200);
  return new Set(((await res.json()).members as { id: string }[]).map((m) => m.id));
};

describe("the roster a project-scoped key sees", () => {
  it("is the people tied to its projects: project members, assignees, creators, commenters", async () => {
    expect(new Set(await scopedRosterUserIds(key([p1])))).toEqual(new Set([u.a, u.b, u.c, u.d]));
  });

  it.each([["listMembers", memberIds], ["facets members", facetMemberIds]] as const)(
    "%s: a P1 key never sees an org member with no tie to P1",
    async (_n, read) => {
      const seen = await read(key([p1]));
      for (const id of [u.a, u.b, u.c, u.d]) expect(seen.has(id)).toBe(true);
      for (const id of [u.e, u.f, u.owner]) expect(seen.has(id)).toBe(false);
    },
  );

  it.each([["listMembers", memberIds], ["facets members", facetMemberIds]] as const)(
    "%s: an org-wide key and a browser session see everyone",
    async (_n, read) => {
      for (const ctx of [key(), session()]) {
        const seen = await read(ctx);
        for (const id of Object.values(u)) expect(seen.has(id)).toBe(true);
      }
    },
  );

  it("a key scoped to a project with no people sees no one", async () => {
    const empty = (await prisma.project.create({ data: { orgId, name: "P3", key: `RC${stamp.slice(0, 3).toUpperCase()}` } })).id;
    expect(await scopedRosterUserIds(key([empty]))).toEqual([]);
    expect((await memberIds(key([empty]))).size).toBe(0);
  });
});
