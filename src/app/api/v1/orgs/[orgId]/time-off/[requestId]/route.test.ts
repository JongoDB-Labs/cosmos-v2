import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, isManagerOf, hasManager } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    timeOffRequest: { findFirst: vi.fn(), update: vi.fn() },
  },
  getAuthContext: vi.fn(),
  isManagerOf: vi.fn(),
  hasManager: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/time/timesheet-actions", () => ({ isManagerOf, hasManager }));

import { PATCH } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const MY_REPORT = "33333333-3333-4333-8333-333333333333";
const REQ_ID = "55555555-5555-4555-8555-555555555555";

const bits = (...keys: PermissionKey[]) => keys.reduce((a, k) => a | Permission[k], 0n);

function ctx(...keys: PermissionKey[]): AuthContext {
  const permissions = bits(...keys);
  return {
    userId: ME,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  } as AuthContext;
}

const stored = (over: Record<string, unknown> = {}) => ({
  id: REQ_ID,
  userId: ME,
  status: "PENDING",
  ...over,
});

const updated = (over: Record<string, unknown> = {}) => ({
  id: REQ_ID,
  userId: ME,
  kind: "VACATION",
  status: "APPROVED",
  startDate: new Date("2026-09-21T00:00:00.000Z"),
  endDate: new Date("2026-09-25T00:00:00.000Z"),
  hoursPerDay: 8,
  note: null,
  decidedById: ME,
  decidedAt: new Date("2026-09-27T00:00:00.000Z"),
  decisionNote: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  ...over,
});

const patch = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/orgs/o/time-off/${REQ_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = Promise.resolve({ orgId: ORG_ID, requestId: REQ_ID });
const dataSent = () => prisma.timeOffRequest.update.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  getAuthContext.mockResolvedValue(ctx("TIME_READ", "TIME_APPROVE"));
  prisma.timeOffRequest.findFirst.mockResolvedValue(stored({ userId: MY_REPORT }));
  prisma.timeOffRequest.update.mockResolvedValue(updated());
  isManagerOf.mockResolvedValue(true);
  hasManager.mockResolvedValue(true);
});

describe("PATCH a time-off request", () => {
  it("approves, and records who decided it and when", async () => {
    const res = await PATCH(patch({ action: "approve" }), { params });
    expect(res.status).toBe(200);
    expect(dataSent()).toMatchObject({ status: "APPROVED", decidedById: ME });
    expect(dataSent().decidedAt).toBeInstanceOf(Date);
  });

  it("denies, carrying the reason given", async () => {
    await PATCH(patch({ action: "deny", decisionNote: "Two people already out" }), { params });
    expect(dataSent()).toMatchObject({
      status: "DENIED",
      decisionNote: "Two people already out",
    });
  });

  it("will not decide one that has already been decided", async () => {
    prisma.timeOffRequest.findFirst.mockResolvedValue(
      stored({ userId: MY_REPORT, status: "APPROVED" }),
    );
    const res = await PATCH(patch({ action: "deny" }), { params });
    // 409, not a silent overwrite of who decided it and when.
    expect(res.status).toBe(409);
    expect(prisma.timeOffRequest.update).not.toHaveBeenCalled();
  });

  it("refuses self-approval by somebody who has a supervisor", async () => {
    // The rule comes from approvalAuthority, the same one the timesheet uses.
    prisma.timeOffRequest.findFirst.mockResolvedValue(stored({ userId: ME }));
    hasManager.mockResolvedValue(true);
    isManagerOf.mockResolvedValue(false);
    const res = await PATCH(patch({ action: "approve" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.timeOffRequest.update).not.toHaveBeenCalled();
  });

  it("lets somebody with no supervisor approve their own, so nothing deadlocks", async () => {
    prisma.timeOffRequest.findFirst.mockResolvedValue(stored({ userId: ME }));
    hasManager.mockResolvedValue(false);
    isManagerOf.mockResolvedValue(false);
    expect((await PATCH(patch({ action: "approve" }), { params })).status).toBe(200);
  });

  it("refuses a decision from someone who is neither the supervisor nor an approver", async () => {
    getAuthContext.mockResolvedValue(ctx("TIME_READ"));
    isManagerOf.mockResolvedValue(false);
    const res = await PATCH(patch({ action: "approve" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.timeOffRequest.update).not.toHaveBeenCalled();
  });

  it("lets me take back my own ask", async () => {
    prisma.timeOffRequest.findFirst.mockResolvedValue(stored({ userId: ME }));
    prisma.timeOffRequest.update.mockResolvedValue(updated({ status: "WITHDRAWN" }));
    const res = await PATCH(patch({ action: "withdraw" }), { params });
    expect(res.status).toBe(200);
    expect(dataSent()).toEqual({ status: "WITHDRAWN" });
  });

  it("will not let even an approver withdraw somebody else's", async () => {
    // Withdrawing another person's request looks identical to denying it, but
    // leaves no record that a decision was made.
    const res = await PATCH(patch({ action: "withdraw" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.timeOffRequest.update).not.toHaveBeenCalled();
  });

  it("is 404 for a request in another org", async () => {
    prisma.timeOffRequest.findFirst.mockResolvedValue(null);
    expect((await PATCH(patch({ action: "approve" }), { params })).status).toBe(404);
  });

  it("rejects an action it does not recognise", async () => {
    expect((await PATCH(patch({ action: "delete" }), { params })).status).toBe(400);
  });
});
