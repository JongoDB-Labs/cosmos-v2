// @vitest-environment node
//
// Whose timesheets a key limited to some projects lists, against a real
// database.
//
// A timesheet is one person's week, with no project of its own, so a
// project-scoped key can't be narrowed by project the way its time entries are.
// It is narrowed by PERSON instead (`keyTimeRoster`): the people tied to the
// key's projects (`scopedRosterUserIds`, the rule every route that lists people
// applies) and always the key's own minter. Approvers outside it go unnamed and
// their ids are withheld. An org-wide key and a browser session list exactly
// what they did before.
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
// The caller (an owner) is on P and approves A's and B's weeks. A works on P,
// B on Q, and C (who also approves A's week, and signed its cost lane) is on Q.
const u = { caller: "", a: "", b: "", c: "" };
const name = (k: keyof typeof u) => `${k} ${stamp}`;
let sheetA = "", sheetB = "", sheetSelf = "";

const session = (): AuthContext => ({
  userId: u.caller, orgId, orgRole: OrgRole.OWNER, abacRules: [],
  permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
});
/** The owner's key, as apiKeyAuthContext builds it. `read` puts the people of
 *  the key's projects in its roster; without it the roster is empty. */
const key = (projectScope?: string[], scopes = ["read", "time:read"]): AuthContext => {
  const mask = RolePermissions.OWNER & scopeMask(scopes);
  return {
    ...session(), permissions: mask, basePermissions: mask,
    isApiKey: true, scopes, ...(projectScope ? { projectScope } : {}),
  };
};

type Row = {
  id: string; userId: string; workerName: string | null; approverNames: string[];
  approverIds: string[]; laborApprovedById: string | null; costApprovedById: string | null;
};
async function list(ctx: AuthContext, qs = ""): Promise<{ status: number; rows: Row[] }> {
  h.ctx = ctx;
  const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/timesheets${qs}`), {
    params: Promise.resolve({ orgId }),
  });
  if (res.status !== 200) return { status: res.status, rows: [] };
  return { status: 200, rows: ((await res.json()) as { data: Row[] }).data };
}
const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

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
  // A's and B's weeks are waiting on the caller, which is what makes them
  // readable to the caller's key at all (a key holds TIME_READ, not
  // TIME_READ_ALL). The caller's own week is always readable.
  const week = { orgId, periodStart: new Date("2026-03-02"), periodEnd: new Date("2026-03-08"), status: "SUBMITTED" as const };
  sheetA = (await prisma.timesheet.create({
    data: { ...week, userId: u.a, approverIds: [u.caller, u.c], laborApprovedById: u.caller, costApprovedById: u.c },
  })).id;
  sheetB = (await prisma.timesheet.create({ data: { ...week, userId: u.b, approverIds: [u.caller] } })).id;
  sheetSelf = (await prisma.timesheet.create({ data: { ...week, status: "OPEN", userId: u.caller, approverIds: [] } })).id;
});

afterAll(async () => {
  await prisma.timesheet.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } }).catch(() => undefined);
});

describe("a key limited to some projects", () => {
  it("lists only the weeks of its minter and the people tied to its projects", async () => {
    const { status, rows } = await list(key([P]));
    expect(status).toBe(200);
    expect(ids(rows)).toEqual([sheetA, sheetSelf].sort());
    expect(rows.find((r) => r.id === sheetA)?.workerName).toBe(name("a"));
  });

  it("names only the approvers inside its roster, and withholds the others' ids", async () => {
    const { rows } = await list(key([P]));
    const a = rows.find((r) => r.id === sheetA);
    expect(a?.approverNames).toEqual([name("caller")]);
    expect(a?.approverIds).toEqual([u.caller]);
    // The labour lane was signed inside the roster and keeps its signer; the
    // cost lane was signed by C, outside it.
    expect([a?.laborApprovedById, a?.costApprovedById]).toEqual([u.caller, null]);
  });

  it("is refused a person outside its projects by name, and still gets one inside", async () => {
    expect((await list(key([P]), `?userId=${u.b}`)).status).toBe(403);
    expect(ids((await list(key([P]), `?userId=${u.a}`)).rows)).toEqual([sheetA]);
  });

  it("the approver's queue is narrowed the same way", async () => {
    expect(ids((await list(key([P]), "?awaitingMe=1")).rows)).toEqual([sheetA]);
  });
});

describe("a key limited to some projects, without `read`", () => {
  // Its roster is empty: it reads no project's items, so nobody is tied to its
  // projects for it. It still sees its own minter, and nobody else.
  const timeOnly = () => key([P], ["time:write"]);

  it("lists its minter's own weeks and nobody else's", async () => {
    const { status, rows } = await list(timeOnly());
    expect(status).toBe(200);
    expect(ids(rows)).toEqual([sheetSelf]);
  });

  it("answers its minter by name, and refuses anyone else", async () => {
    const self = await list(timeOnly(), `?userId=${u.caller}`);
    expect([self.status, ids(self.rows)]).toEqual([200, [sheetSelf]]);
    expect((await list(timeOnly(), `?userId=${u.a}`)).status).toBe(403);
  });
});

describe.each([
  ["an org-wide key", () => key()],
  ["an org-wide key without `read`", () => key(undefined, ["time:write"])],
  ["an owner's browser session", session],
])("%s lists as before", (_who, ctx) => {
  it("every readable week, with every approver named and every id intact", async () => {
    const { status, rows } = await list(ctx());
    expect(status).toBe(200);
    expect(ids(rows)).toEqual([sheetA, sheetB, sheetSelf].sort());
    const a = rows.find((r) => r.id === sheetA);
    expect(a?.approverNames.sort()).toEqual([name("caller"), name("c")].sort());
    expect(a?.approverIds.sort()).toEqual([u.caller, u.c].sort());
    expect([a?.laborApprovedById, a?.costApprovedById]).toEqual([u.caller, u.c]);
    expect(ids((await list(ctx(), `?userId=${u.b}`)).rows)).toEqual([sheetB]);
  });
});
