// @vitest-environment node
//
// Routing decides who a submitted timesheet is HANDED TO. It is not the
// authority check — see approval.ts — and the two answer different questions,
// so these tests pin the difference rather than assuming they agree.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    orgMember: { findMany: vi.fn() },
    employee: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  routeFor,
  approversInOrg,
  managerUserIdOf,
  resolveApprovalRoute,
} from "./routing";
import { Permission, maskToDb } from "@/lib/rbac/permissions";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "99999999-9999-9999-9999-999999999999";
const WORKER = "22222222-2222-2222-2222-222222222222";
const BOSS = "33333333-3333-3333-3333-333333333333";
const ADMIN_A = "44444444-4444-4444-4444-444444444444";
const ADMIN_B = "55555555-5555-5555-5555-555555555555";

beforeEach(() => vi.clearAllMocks());

describe("routeFor", () => {
  it("routes to the supervisor when the org chart names one", () => {
    expect(
      routeFor({
        subjectUserId: WORKER,
        managerUserId: BOSS,
        approverUserIds: [ADMIN_A, ADMIN_B],
      }),
    ).toEqual({ approverId: BOSS, notify: [BOSS], reason: "manager" });
  });

  it("prefers the supervisor over the admin pool", () => {
    // Otherwise every submission pages every admin in the company, and the
    // supervisor — the one person who knows whether the hours are real — is
    // just one voice in a broadcast.
    const route = routeFor({
      subjectUserId: WORKER,
      managerUserId: BOSS,
      approverUserIds: [ADMIN_A, ADMIN_B],
    });
    expect(route.notify).toEqual([BOSS]);
    expect(route.notify).not.toContain(ADMIN_A);
  });

  it("falls back to the approver pool when there is no supervisor", () => {
    const route = routeFor({
      subjectUserId: WORKER,
      managerUserId: null,
      approverUserIds: [ADMIN_A, ADMIN_B],
    });
    expect(route.reason).toBe("admin_pool");
    expect(route.approverId).toBeNull();
    expect(route.notify.sort()).toEqual([ADMIN_A, ADMIN_B].sort());
  });

  it("treats a self-referential manager as NO manager", () => {
    // An employee record whose manager is itself names no supervisor. Routing
    // to it would deadlock the sheet: approvalAuthority() refuses self-approval
    // whenever a manager exists, so the worker could neither sign their own
    // week nor be covered by anyone else's authority.
    const route = routeFor({
      subjectUserId: WORKER,
      managerUserId: WORKER,
      approverUserIds: [ADMIN_A],
    });
    expect(route.reason).toBe("admin_pool");
    expect(route.approverId).toBeNull();
    expect(route.notify).toEqual([ADMIN_A]);
  });

  it("never notifies the worker about their own submission", () => {
    const route = routeFor({
      subjectUserId: ADMIN_A,
      managerUserId: null,
      approverUserIds: [ADMIN_A, ADMIN_B],
    });
    expect(route.notify).toEqual([ADMIN_B]);
  });

  it("reports 'none' when the worker is the only possible approver", () => {
    // The top of the org chart. Submission still succeeds — blocking it would
    // strand the hours — but the UI has to say so rather than imply someone
    // was asked.
    const route = routeFor({
      subjectUserId: ADMIN_A,
      managerUserId: null,
      approverUserIds: [ADMIN_A],
    });
    expect(route).toEqual({ approverId: null, notify: [], reason: "none" });
  });

  it("deduplicates the pool", () => {
    const route = routeFor({
      subjectUserId: WORKER,
      managerUserId: null,
      approverUserIds: [ADMIN_A, ADMIN_A, ADMIN_B],
    });
    expect(route.notify).toHaveLength(2);
  });
});

describe("approversInOrg", () => {
  const member = (
    userId: string,
    role: string,
    permissions: string | null,
    grants: string[] = [],
  ) => ({
    userId,
    role,
    permissions,
    workRoles: grants.map((g) => ({ workRole: { grants: g } })),
  });

  it("includes admins and excludes plain members", () => {
    prisma.orgMember.findMany.mockResolvedValue([
      member(ADMIN_A, "ADMIN", null),
      member(WORKER, "MEMBER", null),
    ]);
    return expect(approversInOrg(ORG)).resolves.toEqual([ADMIN_A]);
  });

  it("includes someone granted TIME_APPROVE through a WORK ROLE", async () => {
    // This is the assignable-approver path: without folding work-role grants
    // the queue would disagree with the authority check, and a legitimate
    // approver would be able to sign sheets they were never shown.
    prisma.orgMember.findMany.mockResolvedValue([
      member(WORKER, "MEMBER", null, [maskToDb(Permission.TIME_APPROVE)]),
    ]);
    await expect(approversInOrg(ORG)).resolves.toEqual([WORKER]);
  });

  it("includes someone granted TIME_APPROVE as a per-member override", async () => {
    prisma.orgMember.findMany.mockResolvedValue([
      member(WORKER, "MEMBER", maskToDb(Permission.TIME_APPROVE)),
    ]);
    await expect(approversInOrg(ORG)).resolves.toEqual([WORKER]);
  });

  it("does NOT treat an unrelated work-role grant as approval authority", async () => {
    prisma.orgMember.findMany.mockResolvedValue([
      member(WORKER, "MEMBER", null, [maskToDb(Permission.TIME_READ)]),
    ]);
    await expect(approversInOrg(ORG)).resolves.toEqual([]);
  });
});

describe("managerUserIdOf", () => {
  it("returns the supervisor's user id", async () => {
    prisma.employee.findFirst.mockResolvedValue({
      manager: { userId: BOSS, orgId: ORG },
    });
    await expect(managerUserIdOf(ORG, WORKER)).resolves.toBe(BOSS);
  });

  it("returns null when the employee has no manager", async () => {
    prisma.employee.findFirst.mockResolvedValue({ manager: null });
    await expect(managerUserIdOf(ORG, WORKER)).resolves.toBeNull();
  });

  it("returns null when there is no employee record at all", async () => {
    prisma.employee.findFirst.mockResolvedValue(null);
    await expect(managerUserIdOf(ORG, WORKER)).resolves.toBeNull();
  });

  it("refuses a manager belonging to another org", async () => {
    // Employee.managerId is a bare FK with no org constraint, so a cross-tenant
    // pointer is representable. Routing to it would leak one org's timesheet
    // into another's approval queue.
    prisma.employee.findFirst.mockResolvedValue({
      manager: { userId: BOSS, orgId: OTHER_ORG },
    });
    await expect(managerUserIdOf(ORG, WORKER)).resolves.toBeNull();
  });
});

describe("resolveApprovalRoute", () => {
  it("combines the org chart and the approver pool", async () => {
    prisma.employee.findFirst.mockResolvedValue({
      manager: { userId: BOSS, orgId: ORG },
    });
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: ADMIN_A, role: "ADMIN", permissions: null, workRoles: [] },
    ]);

    await expect(resolveApprovalRoute(ORG, WORKER)).resolves.toEqual({
      approverId: BOSS,
      notify: [BOSS],
      reason: "manager",
    });
  });

  it("falls back to the pool when the worker has no employee record", async () => {
    // The user's own org today: zero Employee rows, so nobody has a supervisor.
    prisma.employee.findFirst.mockResolvedValue(null);
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: ADMIN_A, role: "OWNER", permissions: null, workRoles: [] },
    ]);

    await expect(resolveApprovalRoute(ORG, WORKER)).resolves.toEqual({
      approverId: null,
      notify: [ADMIN_A],
      reason: "admin_pool",
    });
  });
});
