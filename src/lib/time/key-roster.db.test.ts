// @vitest-environment node
//
// Every time route that answers per PERSON gives a key limited to some projects
// the same set of people, against a real database: its own minter, plus the
// people tied to its projects (`keyTimeRoster`). The week statuses, the person
// picker, team leave, leave balances and "who approves me" all agree with the
// timesheet list (timesheets/key-scope.db.test.ts). A browser session and an
// org-wide key see what they saw before.
//
// (Time ENTRIES carry a project, so they take the key's project ceiling
// instead: time-entries/key-ceiling.db.test.ts.)
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as periods } from "@/app/api/v1/orgs/[orgId]/timesheets/periods/route";
import { GET as people } from "@/app/api/v1/orgs/[orgId]/time-entries/people/route";
import { GET as myApprovers } from "@/app/api/v1/orgs/[orgId]/time-entries/my-approvers/route";
import { GET as timeOff } from "@/app/api/v1/orgs/[orgId]/time-off/route";
import { GET as summary } from "@/app/api/v1/orgs/[orgId]/time-off/summary/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", P = "", Q = "";
// The caller (an owner) and A are on P; B and C are on Q. A and C are admins,
// so they are the pool the caller's own week goes to, and (being employees)
// the supervisors a key, which can't approve its own week, is offered.
const u = { caller: "", a: "", b: "", c: "" };
const name = (k: keyof typeof u) => `${k} ${stamp}`;
const leave = (k: keyof typeof u) => `leave-${k}-${stamp}`;

const session = (): AuthContext => ({
  userId: u.caller, orgId, orgRole: OrgRole.OWNER, abacRules: [],
  permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
});
const key = (projectScope?: string[], scopes = ["read", "time:read"]): AuthContext => {
  const mask = RolePermissions.OWNER & scopeMask(scopes);
  return { ...session(), permissions: mask, basePermissions: mask, isApiKey: true, scopes, ...(projectScope ? { projectScope } : {}) };
};

type Handler = (req: NextRequest, c: { params: Promise<{ orgId: string }> }) => Promise<Response>;
async function call(handler: Handler, ctx: AuthContext, path: string) {
  h.ctx = ctx;
  const res = await handler(new NextRequest(`http://localhost/api/v1/orgs/${orgId}${path}`), { params: Promise.resolve({ orgId }) });
  const text = await res.text();
  return { status: res.status, text };
}
/** Which of the four people a response names, by display name or leave note. */
async function named(handler: Handler, ctx: AuthContext, path: string, by: (k: keyof typeof u) => string = name) {
  const { status, text } = await call(handler, ctx, path);
  expect(status, text).toBe(200);
  return (Object.keys(u) as (keyof typeof u)[]).filter((k) => text.includes(by(k)));
}
/** Who my-approvers names, and who it offers as a supervisor to ask. */
async function approvers(ctx: AuthContext) {
  const { status, text } = await call(myApprovers as Handler, ctx, "/time-entries/my-approvers");
  expect(status, text).toBe(200);
  const body = JSON.parse(text) as { approverNames: string[]; eligibleSupervisors: Array<{ displayName: string }> };
  return { names: body.approverNames.sort(), offered: body.eligibleSupervisors.map((s) => s.displayName).sort() };
}
const periodStatus = async (ctx: AuthContext, who: keyof typeof u) =>
  (await call(periods as Handler, ctx, `/timesheets/periods?year=2026&userId=${u[who]}`)).status;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `tkr ${stamp}`, slug: `tkr-${stamp}` } })).id;
  const om: Record<string, string> = {};
  const role = { caller: "OWNER", a: "ADMIN", b: "MEMBER", c: "ADMIN" } as const;
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@tkr.test`, displayName: name(k) } })).id;
    om[k] = (await prisma.orgMember.create({ data: { orgId, userId: u[k], role: role[k], permissions: "0" } })).id;
  }
  P = (await prisma.project.create({ data: { orgId, name: "P", key: `KP${stamp.slice(0, 4).toUpperCase()}` } })).id;
  Q = (await prisma.project.create({ data: { orgId, name: "Q", key: `KQ${stamp.slice(0, 4).toUpperCase()}` } })).id;
  for (const [k, projectId] of [["caller", P], ["a", P], ["b", Q], ["c", Q]] as const) {
    await prisma.projectMember.create({ data: { projectId, orgMemberId: om[k] } });
  }
  for (const k of ["caller", "a", "c"] as const) {
    await prisma.employee.create({ data: { orgId, userId: u[k], costRate: 0, createdById: u.caller } });
  }
  // A's and B's weeks wait on the caller, which makes their time readable to
  // the caller's key (a key holds TIME_READ, not TIME_READ_ALL). C's is not.
  const week = { orgId, periodStart: new Date("2026-03-02"), periodEnd: new Date("2026-03-08"), status: "SUBMITTED" as const };
  for (const k of ["a", "b"] as const) await prisma.timesheet.create({ data: { ...week, userId: u[k], approverIds: [u.caller] } });
  for (const k of ["caller", "a", "b"] as const) {
    await prisma.timeOffRequest.create({
      data: { orgId, userId: u[k], kind: "VACATION", startDate: new Date("2026-04-06"), endDate: new Date("2026-04-10"), note: leave(k) },
    });
  }
});

afterAll(async () => {
  await prisma.timeOffRequest.deleteMany({ where: { orgId } });
  await prisma.timesheet.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } }).catch(() => undefined);
});

describe("a key limited to P sees its minter and P's people on every per-person time route", () => {
  const scoped = () => key([P]);

  it("week statuses: its minter and A, and B is refused", async () => {
    expect([await periodStatus(scoped(), "caller"), await periodStatus(scoped(), "a"), await periodStatus(scoped(), "b")])
      .toEqual([200, 200, 403]);
  });

  it("the person picker", async () => {
    expect(await named(people as Handler, scoped(), "/time-entries/people")).toEqual(["caller", "a"]);
  });

  it("team leave, and B's by name is refused", async () => {
    expect(await named(timeOff as Handler, scoped(), "/time-off?scope=team", leave)).toEqual(["caller", "a"]);
    expect((await call(timeOff as Handler, scoped(), `/time-off?userId=${u.b}`)).status).toBe(403);
  });

  it("leave balances", async () => {
    expect(await named(summary as Handler, scoped(), "/time-off/summary?year=2026")).toEqual(["caller", "a"]);
  });

  it("who approves its minter: only the approvers inside the roster are named or offered", async () => {
    expect(await approvers(scoped())).toEqual({ names: [name("a")], offered: [name("a")] });
  });

  it("without `read` it reads no project's people, so it sees only its minter", async () => {
    const timeOnly = key([P], ["time:write"]);
    expect(await named(people as Handler, timeOnly, "/time-entries/people")).toEqual(["caller"]);
    expect(await named(timeOff as Handler, timeOnly, "/time-off?scope=team", leave)).toEqual(["caller"]);
    expect([await periodStatus(timeOnly, "caller"), await periodStatus(timeOnly, "a")]).toEqual([200, 403]);
  });
});

describe.each([
  // A key can't approve its own week, so it is offered supervisors to ask; the
  // owner in person can, so is offered none.
  ["an org-wide key", () => key(), ["caller", "a", "b"], [name("a"), name("c")]],
  ["an owner's browser session", session, ["caller", "a", "b", "c"], []],
])("%s sees what it saw before", (_who, ctx, readable, offered) => {
  it("week statuses for B", async () => {
    expect(await periodStatus(ctx(), "b")).toBe(200);
  });

  it("the person picker and leave balances", async () => {
    expect(await named(people as Handler, ctx(), "/time-entries/people")).toEqual(readable);
    expect(await named(summary as Handler, ctx(), "/time-off/summary?year=2026")).toEqual(readable);
  });

  it("team leave, and B's by name", async () => {
    expect(await named(timeOff as Handler, ctx(), "/time-off?scope=team", leave)).toEqual(["caller", "a", "b"]);
    expect(await named(timeOff as Handler, ctx(), `/time-off?userId=${u.b}`, leave)).toEqual(["b"]);
  });

  it("who approves the caller: both admins", async () => {
    expect(await approvers(ctx())).toEqual({ names: [name("a"), name("c")], offered });
  });
});
