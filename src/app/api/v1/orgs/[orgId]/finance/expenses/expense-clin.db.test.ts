// @vitest-environment node
//
// A CLIN on an expense has to be this org's, on a project the filer can open,
// and on the expense's own project when it names one.
//
// The project was checked and the CLIN was not, so an expense could carry
// another org's CLIN id (and land in that CLIN's burn), or a CLIN of a project
// its filer cannot open.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as createExpense } from "./route";
import { PUT as editExpense } from "./[expenseId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", otherOrg = "", filer = "", projectA = "", projectB = "", hidden = "";
const clin: Record<"a" | "b" | "hidden" | "foreign", string> = { a: "", b: "", hidden: "", foreign: "" };

const FILER = Permission.ORG_READ | Permission.PROJECT_READ | Permission.FINANCE_READ | Permission.FINANCE_MANAGE;
const as = (): AuthContext => ({ userId: filer, orgId, orgRole: "MEMBER", abacRules: [], permissions: FILER, basePermissions: FILER });
const send = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const create = (body: Record<string, unknown>) =>
  createExpense(send("POST", { amount: 10, date: "2026-10-09", category: `clin-${stamp}`, ...body }), {
    params: Promise.resolve({ orgId }),
  });
const edit = (expenseId: string, body: Record<string, unknown>) =>
  editExpense(send("PUT", body), { params: Promise.resolve({ orgId, expenseId }) });

beforeAll(async () => {
  filer = (await prisma.user.create({ data: { email: `filer-${stamp}@expense-clin.test`, displayName: "Filer" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `ec ${stamp}`, slug: `ec-${stamp}` } })).id;
  otherOrg = (await prisma.organization.create({ data: { name: `ec2 ${stamp}`, slug: `ec2-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: filer, role: "MEMBER", permissions: "0" } });
  const project = (o: string, name: string, key: string, teamScopedAccess = false) =>
    prisma.project.create({ data: { orgId: o, name, key: `${key}${stamp.slice(0, 3).toUpperCase()}`, teamScopedAccess } });
  projectA = (await project(orgId, "A", "EA")).id;
  projectB = (await project(orgId, "B", "EB")).id;
  hidden = (await project(orgId, "Closed", "EH", true)).id;
  const foreignProject = (await project(otherOrg, "Theirs", "EF")).id;
  const mk = (o: string, projectId: string) => prisma.clin.create({ data: { orgId: o, projectId, code: "0001", title: "c" } });
  clin.a = (await mk(orgId, projectA)).id;
  clin.b = (await mk(orgId, projectB)).id;
  clin.hidden = (await mk(orgId, hidden)).id;
  clin.foreign = (await mk(otherOrg, foreignProject)).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrg] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: filer } }).catch(() => undefined);
});

describe("filing an expense against a CLIN", () => {
  it("refuses another org's CLIN", async () => {
    h.ctx = as();
    const res = await create({ projectId: projectA, clinId: clin.foreign });
    expect(res.status).toBe(400);
    expect(await prisma.expense.count({ where: { clinId: clin.foreign } })).toBe(0);
  });

  it("refuses a CLIN of a project the filer cannot open, the same way", async () => {
    h.ctx = as();
    const res = await create({ clinId: clin.hidden });
    expect(res.status).toBe(400);
    expect(await prisma.expense.count({ where: { clinId: clin.hidden } })).toBe(0);
  });

  it("refuses a CLIN of a different project than the expense's", async () => {
    h.ctx = as();
    const res = await create({ projectId: projectA, clinId: clin.b });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/isn't part of this project/i);
  });

  it("control: a CLIN on the expense's own project is accepted", async () => {
    h.ctx = as();
    const res = await create({ projectId: projectA, clinId: clin.a });
    expect(res.status).toBe(201);
  });
});

describe("changing an expense's CLIN", () => {
  it("refuses another org's CLIN and leaves the expense as it was; accepts its own project's", async () => {
    h.ctx = as();
    const expense = await prisma.expense.create({
      data: { orgId, amount: 5, date: new Date("2026-10-09"), category: `edit-${stamp}`, projectId: projectA, createdById: filer },
    });
    expect((await edit(expense.id, { clinId: clin.foreign })).status).toBe(400);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } })).clinId).toBeNull();
    expect((await edit(expense.id, { clinId: clin.b })).status).toBe(400);
    // Control.
    expect((await edit(expense.id, { clinId: clin.a })).status).toBe(200);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } })).clinId).toBe(clin.a);
  });

  it("moving it to another project with the old project's CLIN still on it is refused", async () => {
    h.ctx = as();
    const expense = await prisma.expense.create({
      data: { orgId, amount: 5, date: new Date("2026-10-09"), category: `move-${stamp}`, projectId: projectA, clinId: clin.a, createdById: filer },
    });
    expect((await edit(expense.id, { projectId: projectB })).status).toBe(400);
    // Control: moving it with that project's CLIN is fine.
    expect((await edit(expense.id, { projectId: projectB, clinId: clin.b })).status).toBe(200);
  });
});
