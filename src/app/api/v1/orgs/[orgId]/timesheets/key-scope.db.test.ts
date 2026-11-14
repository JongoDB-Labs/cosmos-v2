// @vitest-environment node
//
// Whose timesheets a key limited to some projects lists, against a real
// database.
//
// A timesheet is one person's week, with no project of its own, so a
// project-scoped key can't be narrowed by project the way its time entries are.
// It is narrowed by PERSON instead, with the roster rule every route that lists
// people applies (`scopedRosterUserIds`): the worker must be tied to the key's
// projects, and approvers outside them go unnamed. An org-wide key and a
// browser session list exactly what they did before.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", P = "", Q = "";
// The caller (an owner) and the approver of A's week; A works on P, B on Q, and
// C (who also approves A's week) is on Q only.
const u = { caller: "", a: "", b: "", c: "" };
const name = (k: keyof typeof u) => `${k} ${stamp}`;
let sheetA = "", sheetB = "";

const session = (): AuthContext => ({
  userId: u.caller, orgId, orgRole: OrgRole.OWNER, abacRules: [],
  permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
});
/** The owner's key, as apiKeyAuthContext builds it. `read` too: the roster is the
 *  people of the projects the key reads items in. */
const key = (projectScope?: string[]): AuthContext => {
  const scopes = ["read", "time:read"];
  const mask = RolePermissions.OWNER & scopeMask(scopes);
  return {
    ...session(), permissions: mask, basePermissions: mask,
    isApiKey: true, scopes, ...(projectScope ? { projectScope } : {}),
  };
};

type Row = { id: string; userId: string; workerName: string | null; approverNames: string[] };
async function list(ctx: AuthContext, qs = ""): Promise<{ status: number; rows: Row[] }> {
  h.ctx = ctx;
  const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/timesheets${qs}`), {
    params: Promise.resolve({ orgId }),
  });
  if (res.status !== 200) return { status: res.status, rows: [] };
  return { status: 200, rows: ((await res.json()) as { data: Row[] }).data };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `tsk ${stamp}`, slug: `tsk-${stamp}` } })).id;
  const om: Record<string, string> = {};
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@tsk.test`, displayName: name(k) } })).id;
    om[k] = (await prisma.orgMember.create({
      data: { orgId, userId: u[k], role: k === "caller" ? "OWNER" : "MEMBER", permissions: "0" },
    })).id;
  }
  P = (await prisma.project.create({ data: { orgId, name: "P", key: `TP${stamp.slice(0, 4).toUpperCase()}` } })).id;
  Q = (await prisma.project.create({ data: { orgId, name: "Q", key: `TQ${stamp.slice(0, 4).toUpperCase()}` } })).id;
  for (const [k, projectId] of [["caller", P], ["a", P], ["b", Q], ["c", Q]] as const) {
    await prisma.projectMember.create({ data: { projectId, orgMemberId: om[k] } });
  }
  // Both weeks are waiting on the caller, which is what makes them readable to
  // the caller's key at all (a key holds TIME_READ, not TIME_READ_ALL).
  const week = { orgId, periodStart: new Date("2026-03-02"), periodEnd: new Date("2026-03-08"), status: "SUBMITTED" as const };
  sheetA = (await prisma.timesheet.create({ data: { ...week, userId: u.a, approverIds: [u.caller, u.c] } })).id;
  sheetB = (await prisma.timesheet.create({ data: { ...week, userId: u.b, approverIds: [u.caller] } })).id;
});

afterAll(async () => {
  await prisma.timesheet.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } }).catch(() => undefined);
});

describe("a key limited to some projects", () => {
  it("lists only the weeks of people tied to its projects", async () => {
    const { status, rows } = await list(key([P]));
    expect(status).toBe(200);
    expect(rows.map((r) => r.id)).toEqual([sheetA]);
    expect(rows[0].workerName).toBe(name("a"));
  });

  it("names only the approvers inside its roster", async () => {
    const { rows } = await list(key([P]));
    expect(rows.find((r) => r.id === sheetA)?.approverNames).toEqual([name("caller")]);
  });

  it("is refused a person outside its projects by name, and still gets one inside", async () => {
    expect((await list(key([P]), `?userId=${u.b}`)).status).toBe(403);
    expect((await list(key([P]), `?userId=${u.a}`)).rows.map((r) => r.id)).toEqual([sheetA]);
  });

  it("the approver's queue is narrowed the same way", async () => {
    expect((await list(key([P]), "?awaitingMe=1")).rows.map((r) => r.id)).toEqual([sheetA]);
  });
});

describe.each([
  ["an org-wide key", () => key()],
  ["an owner's browser session", session],
])("%s lists as before", (_who, ctx) => {
  it("every readable week, with every approver named", async () => {
    const { status, rows } = await list(ctx());
    expect(status).toBe(200);
    expect(rows.map((r) => r.id).sort()).toEqual([sheetA, sheetB].sort());
    expect(rows.find((r) => r.id === sheetA)?.approverNames.sort()).toEqual([name("caller"), name("c")].sort());
    expect((await list(ctx(), `?userId=${u.b}`)).rows.map((r) => r.id)).toEqual([sheetB]);
  });
});
