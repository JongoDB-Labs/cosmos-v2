// @vitest-environment node
//
// One approval rule for every approve path: `approvalAuthority`, the rule the
// timesheet and time-off decisions already used. An approver does not approve
// their OWN hours or expenses while somebody supervises them -- someone else is
// designated, and signing for yourself goes round them. At the top of the
// chart nobody else is designated, and refusing would only deadlock.
//
// The per-entry time approval and both expense approvals carried the bit check
// and nothing else, so a supervised approver approved their own 40 hours (which
// payroll then pays) or their own reimbursable expense.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as approveEntry } from "./time-entries/[entryId]/approve/route";
import { POST as approveExpense } from "./finance/expenses/[expenseId]/approve/route";
import { POST as bulkApprove } from "./finance/expenses/bulk-approve/route";
import { PUT as editExpense, DELETE as deleteExpense } from "./finance/expenses/[expenseId]/route";
import { PUT as setSupervisors } from "./employees/[employeeId]/supervisors/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "";
const users: Record<string, string> = {};
const entries: Record<string, string> = {};
const emp: Record<string, string> = {};
const expenses: Record<string, string> = {};

const APPROVER =
  Permission.ORG_READ | Permission.TIME_READ | Permission.TIME_APPROVE |
  Permission.FINANCE_READ | Permission.FINANCE_MANAGE | Permission.EXPENSE_APPROVE;
const as = (who: string): AuthContext => ({
  userId: users[who], orgId, orgRole: "MEMBER", abacRules: [], permissions: APPROVER, basePermissions: APPROVER,
});
const at = (extra: Record<string, string>) => ({ params: Promise.resolve({ orgId, ...extra }) }) as never;
const post = (body: unknown) =>
  new NextRequest("http://localhost/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeAll(async () => {
  // approver reports to boss; top reports to nobody; worker reports to approver.
  for (const who of ["approver", "boss", "top", "worker"]) {
    users[who] = (await prisma.user.create({ data: { email: `${who}-${stamp}@approve.test`, displayName: who } })).id;
  }
  orgId = (await prisma.organization.create({ data: { name: `approve ${stamp}`, slug: `approve-${stamp}` } })).id;
  for (const [who, id] of Object.entries(users)) {
    await prisma.orgMember.create({ data: { orgId, userId: id, role: "MEMBER", permissions: "0" } });
    emp[who] = (await prisma.employee.create({ data: { orgId, userId: id, costRate: 50, createdById: users.boss } })).id;
  }
  await prisma.employeeSupervisor.createMany({
    data: [
      { orgId, employeeId: emp.approver, supervisorId: emp.boss, createdById: users.boss },
      { orgId, employeeId: emp.worker, supervisorId: emp.approver, createdById: users.boss },
    ],
  });

  const day = new Date("2026-10-06T00:00:00Z");
  for (const who of ["approver", "worker", "top"]) {
    entries[who] = (await prisma.timeEntry.create({
      data: { orgId, userId: users[who], date: day, hours: 40, status: "SUBMITTED", description: "week" },
    })).id;
  }
  const expense = (who: string) =>
    prisma.expense.create({
      data: { orgId, amount: 123.45, date: day, category: "Travel", status: "SUBMITTED", createdById: users[who], reimbursable: false },
    });
  for (const [k, who] of [["approver", "approver"], ["worker", "worker"], ["bulkMine", "approver"], ["bulkTheirs", "worker"]] as const) {
    expenses[k] = (await expense(who)).id;
  }
  // Already approved -- by someone else -- for the amend-after-approval cases.
  for (const [k, who] of [
    ["approvedMine", "approver"], ["approvedTheirs", "worker"], ["deleteMine", "approver"], ["deleteTheirs", "worker"],
  ] as const) {
    expenses[k] = (await prisma.expense.create({
      data: { orgId, amount: 50, date: day, category: "Meals", status: "APPROVED", approvedById: users.boss, approvedAt: day, createdById: users[who] },
    })).id;
  }
});

afterAll(async () => {
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }).catch(() => undefined);
});

describe("approving one time entry", () => {
  it("refuses a supervised approver's own entry, and leaves it waiting", async () => {
    h.ctx = as("approver");
    const res = await approveEntry(post({ action: "approve" }), at({ entryId: entries.approver }));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/supervisor/i);
    const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entries.approver } });
    expect(row).toMatchObject({ status: "SUBMITTED", approvedById: null });
  });

  it("control: the same approver approves somebody else's", async () => {
    h.ctx = as("approver");
    const res = await approveEntry(post({ action: "approve" }), at({ entryId: entries.worker }));
    expect(res.status).toBe(200);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entries.worker } })).status).toBe("APPROVED");
  });

  it("control: at the top of the chart there is nobody else to ask", async () => {
    h.ctx = as("top");
    expect((await approveEntry(post({ action: "approve" }), at({ entryId: entries.top }))).status).toBe(200);
  });
});

describe("approving one expense", () => {
  it("refuses a supervised approver's own expense, and leaves it waiting", async () => {
    h.ctx = as("approver");
    const res = await approveExpense(post({ action: "approve" }), at({ expenseId: expenses.approver }));
    expect(res.status).toBe(403);
    const row = await prisma.expense.findUniqueOrThrow({ where: { id: expenses.approver } });
    expect(row).toMatchObject({ status: "SUBMITTED", approvedById: null });
  });

  it("control: the same approver approves somebody else's", async () => {
    h.ctx = as("approver");
    const res = await approveExpense(post({ action: "approve" }), at({ expenseId: expenses.worker }));
    expect(res.status).toBe(200);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: expenses.worker } })).status).toBe("APPROVED");
  });
});

describe("amending an expense after approval", () => {
  // Approvers may amend a locked expense (corrections). Not their own: that is
  // "have the boss approve 50, then make it 5,000" -- approval by the back door.
  it("refuses a supervised approver's amendment to their own approved expense", async () => {
    h.ctx = as("approver");
    const res = await editExpense(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ amount: 5000 }), headers: { "Content-Type": "application/json" } }),
      at({ expenseId: expenses.approvedMine }),
    );
    expect(res.status).toBe(403);
    expect(Number((await prisma.expense.findUniqueOrThrow({ where: { id: expenses.approvedMine } })).amount)).toBe(50);
  });

  it("control: the same approver may still correct somebody else's", async () => {
    h.ctx = as("approver");
    const res = await editExpense(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ amount: 55 }), headers: { "Content-Type": "application/json" } }),
      at({ expenseId: expenses.approvedTheirs }),
    );
    expect(res.status).toBe(200);
    expect(Number((await prisma.expense.findUniqueOrThrow({ where: { id: expenses.approvedTheirs } })).amount)).toBe(55);
  });
});

describe("approving expenses in bulk", () => {
  it("checks each row: approves the others', skips the approver's own and says so", async () => {
    h.ctx = as("approver");
    const res = await bulkApprove(post({ expenseIds: [expenses.bulkMine, expenses.bulkTheirs] }), at({}));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { approvedCount: number; skipped?: { id: string; reason: string }[] };
    expect(out.approvedCount).toBe(1);
    expect(out.skipped?.map((s) => s.id)).toEqual([expenses.bulkMine]);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: expenses.bulkMine } })).status).toBe("SUBMITTED");
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: expenses.bulkTheirs } })).status).toBe("APPROVED");
  });
});

describe("deleting an expense after it was submitted", () => {
  const del = () => new NextRequest("http://localhost/x", { method: "DELETE" });

  it("refuses a supervised approver's delete of their own approved expense, and keeps it", async () => {
    h.ctx = as("approver");
    const res = await deleteExpense(del(), at({ expenseId: expenses.deleteMine }));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/supervisor/i);
    expect(await prisma.expense.findUnique({ where: { id: expenses.deleteMine } })).not.toBeNull();
  });

  it("control: the same approver may delete somebody else's, and the delete is audited", async () => {
    h.ctx = as("approver");
    const res = await deleteExpense(del(), at({ expenseId: expenses.deleteTheirs }));
    expect(res.status).toBe(204);
    expect(await prisma.expense.findUnique({ where: { id: expenses.deleteTheirs } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { orgId, action: "expense.deleted", entityId: expenses.deleteTheirs },
    });
    expect(audit?.userId).toBe(users.approver);
    expect(audit?.metadata).toMatchObject({ status: "APPROVED" });
  });
});

describe("changing your own supervisors", () => {
  const put = (supervisorIds: string[]) =>
    new NextRequest("http://localhost/x", {
      method: "PUT",
      body: JSON.stringify({ supervisorIds }),
      headers: { "Content-Type": "application/json" },
    });

  it("refuses an employee admin's edit of their own supervisors, so self-approval stays closed", async () => {
    h.ctx = as("approver");
    const res = await setSupervisors(put([]), at({ employeeId: emp.approver }));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/your own supervisors/i);
    expect(await prisma.employeeSupervisor.count({ where: { orgId, employeeId: emp.approver } })).toBe(1);

    // ...and with the supervisor still in place, their own expense stays theirs to wait on.
    const own = await prisma.expense.create({
      data: { orgId, amount: 9.99, date: new Date("2026-10-06T00:00:00Z"), category: "Travel", status: "SUBMITTED", createdById: users.approver },
    });
    expect((await approveExpense(post({ action: "approve" }), at({ expenseId: own.id }))).status).toBe(403);
  });

  it("control: another employee admin may change them, and the change is audited", async () => {
    h.ctx = as("boss");
    const res = await setSupervisors(put([]), at({ employeeId: emp.approver }));
    expect(res.status).toBe(200);
    expect(await prisma.employeeSupervisor.count({ where: { orgId, employeeId: emp.approver } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: { orgId, action: "employee.supervisors_changed", entityId: emp.approver },
    });
    expect(audit?.userId).toBe(users.boss);
  });
});
