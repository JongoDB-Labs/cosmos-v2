// @vitest-environment node
//
// A write that names a PERSON by user id (a goal's, a milestone's or a CRM
// contact's owner; the person a time-off request is filed for) must name a
// current member of the caller's org. The columns reference `users`, which has
// no org, so the database takes any user: another org's member, or someone this
// org removed. Each case below names one of those and must be refused with
// nothing stored; each has a positive control naming a current member.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as createGoal } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/goals/route";
import { PATCH as updateGoal } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/goals/[goalId]/route";
import { POST as createMilestone } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/route";
import { PATCH as updateMilestone } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/[milestoneId]/route";
import { POST as createContact } from "@/app/api/v1/orgs/[orgId]/crm/contacts/route";
import { PUT as updateContact } from "@/app/api/v1/orgs/[orgId]/crm/contacts/[contactId]/route";
import { POST as fileTimeOff } from "@/app/api/v1/orgs/[orgId]/time-off/route";
import { createGoal as createGoalTool, updateGoal as updateGoalTool } from "@/lib/ai/executors/goals-kpis";
import { createMilestone as createMilestoneTool, updateMilestone as updateMilestoneTool } from "@/lib/ai/executors/milestones";
import { createCrmContact as createContactTool, updateCrmContact as updateContactTool } from "@/lib/ai/executors/crm";

const stamp = Math.random().toString(36).slice(2, 8);
const K = stamp.slice(0, 3).toUpperCase();

// `owner` and `colleague` are current members of org A. `outsider` is a member
// of org B only. `former` was a member of org A and has been removed.
let orgA = "", orgB = "", owner = "", colleague = "", outsider = "", former = "";
let p1 = "";

const session = (): AuthContext => ({
  userId: owner, orgId: orgA, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [],
});
const tool = () => ({ orgId: orgA, userId: owner, auth: session() });
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const inOrg = () => ({ params: Promise.resolve({ orgId: orgA }) });
const inP1 = () => ({ params: Promise.resolve({ orgId: orgA, projectId: p1 }) });
const tag = () => `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
const errorOf = (out: unknown) => (out as { error?: string }).error;

/** The people a write must refuse, by why. Getters, as the ids exist only after beforeAll. */
const REFUSED = [
  ["another org's member", () => outsider],
  ["a removed member", () => former],
] as const;

beforeAll(async () => {
  const user = async (n: string) => (await prisma.user.create({ data: { email: `${n}-${stamp}@member.test`, displayName: n } })).id;
  [owner, colleague, outsider, former] = [await user("owner"), await user("colleague"), await user("outsider"), await user("former")];
  orgA = (await prisma.organization.create({ data: { name: `mem a ${stamp}`, slug: `mem-a-${stamp}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `mem b ${stamp}`, slug: `mem-b-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId: orgA, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId: orgA, userId: colleague, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId: orgA, userId: former, role: "MEMBER", permissions: "0", removedAt: new Date() } });
  await prisma.orgMember.create({ data: { orgId: orgB, userId: outsider, role: "OWNER", permissions: "0" } });
  p1 = (await prisma.project.create({ data: { orgId: orgA, name: "P1", key: `MA${K}` } })).id;
  h.ctx = session();
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, colleague, outsider, former] } } }).catch(() => undefined);
});

describe("a goal's owner", () => {
  it.each(REFUSED)("create refuses %s, and creates nothing", async (_why, who) => {
    const title = tag();
    expect((await createGoal(json("POST", { title, ownerId: who() }), inP1())).status).toBe(400);
    expect(await prisma.goal.count({ where: { orgId: orgA, title } })).toBe(0);
  });

  it("update refuses another org's member, and keeps the owner", async () => {
    const goal = await prisma.goal.create({ data: { orgId: orgA, projectId: p1, title: tag(), ownerId: colleague } });
    const at = { params: Promise.resolve({ orgId: orgA, projectId: p1, goalId: goal.id }) };
    expect((await updateGoal(json("PATCH", { ownerId: outsider }), at)).status).toBe(400);
    expect((await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).ownerId).toBe(colleague);
  });

  it("create and update accept a current member", async () => {
    const res = await createGoal(json("POST", { title: tag(), ownerId: colleague }), inP1());
    expect(res.status).toBeLessThan(300);
    const goal = await prisma.goal.create({ data: { orgId: orgA, projectId: p1, title: tag() } });
    const at = { params: Promise.resolve({ orgId: orgA, projectId: p1, goalId: goal.id }) };
    expect((await updateGoal(json("PATCH", { ownerId: colleague }), at)).status).toBeLessThan(300);
  });

  it("the assistant's goal tools refuse an outsider and accept a member", async () => {
    const title = tag();
    expect(errorOf(await createGoalTool({ projectId: p1, title, ownerId: outsider }, tool()))).toBeTruthy();
    expect(await prisma.goal.count({ where: { orgId: orgA, title } })).toBe(0);
    const goal = await prisma.goal.create({ data: { orgId: orgA, projectId: p1, title: tag() } });
    expect(errorOf(await updateGoalTool({ projectId: p1, goalId: goal.id, ownerId: former }, tool()))).toBeTruthy();
    expect((await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).ownerId).toBeNull();
    expect(errorOf(await createGoalTool({ projectId: p1, title: tag(), ownerId: colleague }, tool()))).toBeUndefined();
  });
});

describe("a milestone's owner", () => {
  const due = "2026-12-01T00:00:00.000Z";

  it.each(REFUSED)("create refuses %s, and creates nothing", async (_why, who) => {
    const title = tag();
    expect((await createMilestone(json("POST", { title, dueDate: due, ownerId: who() }), inP1())).status).toBe(400);
    expect(await prisma.milestone.count({ where: { orgId: orgA, title } })).toBe(0);
  });

  it("update refuses another org's member, and keeps the owner", async () => {
    const m = await prisma.milestone.create({ data: { orgId: orgA, projectId: p1, title: tag(), dueDate: new Date(due), ownerId: colleague } });
    const at = { params: Promise.resolve({ orgId: orgA, projectId: p1, milestoneId: m.id }) };
    expect((await updateMilestone(json("PATCH", { ownerId: outsider }), at)).status).toBe(400);
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: m.id } })).ownerId).toBe(colleague);
  });

  it("create accepts a current member", async () => {
    expect((await createMilestone(json("POST", { title: tag(), dueDate: due, ownerId: colleague }), inP1())).status).toBeLessThan(300);
  });

  it("the assistant's milestone tools refuse an outsider and accept a member", async () => {
    const title = tag();
    expect(errorOf(await createMilestoneTool({ projectId: p1, title, dueDate: due, ownerId: outsider }, tool()))).toBeTruthy();
    expect(await prisma.milestone.count({ where: { orgId: orgA, title } })).toBe(0);
    const m = await prisma.milestone.create({ data: { orgId: orgA, projectId: p1, title: tag(), dueDate: new Date(due) } });
    expect(errorOf(await updateMilestoneTool({ projectId: p1, milestoneId: m.id, ownerId: former }, tool()))).toBeTruthy();
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: m.id } })).ownerId).toBeNull();
    expect(errorOf(await createMilestoneTool({ projectId: p1, title: tag(), dueDate: due, ownerId: colleague }, tool()))).toBeUndefined();
  });
});

describe("a CRM contact's owner", () => {
  it.each(REFUSED)("create refuses %s, and creates nothing", async (_why, who) => {
    const name = tag();
    expect((await createContact(json("POST", { name, ownerId: who() }), inOrg())).status).toBe(400);
    expect(await prisma.crmContact.count({ where: { orgId: orgA, name } })).toBe(0);
  });

  it("update refuses another org's member, and keeps the owner", async () => {
    const c = await prisma.crmContact.create({ data: { orgId: orgA, name: tag(), ownerId: colleague } });
    const at = { params: Promise.resolve({ orgId: orgA, contactId: c.id }) };
    expect((await updateContact(json("PUT", { ownerId: outsider }), at)).status).toBe(400);
    expect((await prisma.crmContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(colleague);
  });

  it("create accepts a current member", async () => {
    expect((await createContact(json("POST", { name: tag(), ownerId: colleague }), inOrg())).status).toBeLessThan(300);
  });

  it("the assistant's contact tools refuse an outsider and accept a member", async () => {
    const name = tag();
    expect(errorOf(await createContactTool({ name, ownerId: outsider }, tool()))).toBeTruthy();
    expect(await prisma.crmContact.count({ where: { orgId: orgA, name } })).toBe(0);
    const c = await prisma.crmContact.create({ data: { orgId: orgA, name: tag() } });
    expect(errorOf(await updateContactTool({ contactId: c.id, ownerId: former }, tool()))).toBeTruthy();
    expect((await prisma.crmContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBeNull();
    expect(errorOf(await createContactTool({ name: tag(), ownerId: colleague }, tool()))).toBeUndefined();
  });
});

describe("time off filed for somebody else", () => {
  const request = (userId: string, note = tag()) => ({ kind: "HOLIDAY", startDate: "2026-12-24", endDate: "2026-12-26", note, userId });
  const filedFor = (userId: string) =>
    prisma.auditLog.count({ where: { orgId: orgA, action: "time_off.filed_for", entity: "time_off_request", metadata: { path: ["userId"], equals: userId } } });

  it.each(REFUSED)("an approver can't file for %s, and nothing is stored", async (_why, who) => {
    const body = request(who());
    expect((await fileTimeOff(json("POST", body), inOrg())).status).toBe(400);
    expect(await prisma.timeOffRequest.count({ where: { orgId: orgA, note: body.note } })).toBe(0);
  });

  it("an approver can file for a current member, and it is audited", async () => {
    const res = await fileTimeOff(json("POST", request(colleague)), inOrg());
    expect(res.status).toBe(201);
    expect(await filedFor(colleague)).toBe(1);
  });

  it("filing for yourself needs no audit row", async () => {
    const res = await fileTimeOff(json("POST", { kind: "VACATION", startDate: "2026-12-28", endDate: "2026-12-29" }), inOrg());
    expect(res.status).toBe(201);
    expect(await filedFor(owner)).toBe(0);
  });
});
