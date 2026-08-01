// @vitest-environment node
//
// The state machine and the authority rule are unit-tested in
// lib/time/approval.test.ts. These cover the WIRING: that the route consults
// them at all, enforces ownership on submit, and refuses a rejection with no
// reason. A route can hold a correct state machine and still call it wrong.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, applyTimesheetTransition, isManagerOf, hasManager } =
  vi.hoisted(() => ({
    getAuthContext: vi.fn(),
    prisma: {
      organization: { findUnique: vi.fn() },
      timesheet: { findFirst: vi.fn() },
    },
    applyTimesheetTransition: vi.fn(),
    isManagerOf: vi.fn(),
    hasManager: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/time/timesheet-actions", () => ({
  applyTimesheetTransition,
  isManagerOf,
  hasManager,
}));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "44444444-4444-4444-4444-444444444444";
const THEM = "55555555-5555-5555-5555-555555555555";
const SHEET_ID = "88888888-8888-8888-8888-888888888888";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ME,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}
const params = Promise.resolve({ orgId: ORG_ID, timesheetId: SHEET_ID });
const req = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/orgs/o/timesheets/${SHEET_ID}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

function sheetIs(status: string, userId = ME) {
  prisma.timesheet.findFirst.mockResolvedValue({
    id: SHEET_ID,
    orgId: ORG_ID,
    userId,
    status,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
  applyTimesheetTransition.mockResolvedValue({ id: SHEET_ID, status: "SUBMITTED" });
  isManagerOf.mockResolvedValue(false);
  hasManager.mockResolvedValue(false);
});

describe("POST /timesheets/[id] — submit", () => {
  it("the owner can submit an OPEN week", async () => {
    sheetIs("OPEN", ME);

    const res = await POST(req({ action: "submit" }), { params });

    expect(res.status).toBe(200);
    expect(applyTimesheetTransition).toHaveBeenCalledWith(
      expect.objectContaining({ next: "SUBMITTED", timesheetId: SHEET_ID }),
    );
  });

  it("you cannot submit SOMEONE ELSE's week", async () => {
    // Submitting on another person's behalf defeats attestation: the record
    // would say they handed in hours they never saw.
    sheetIs("OPEN", THEM);

    const res = await POST(req({ action: "submit" }), { params });

    expect(res.status).toBe(403);
    expect(applyTimesheetTransition).not.toHaveBeenCalled();
  });

  it("double submission is refused with 409, not silently repeated", async () => {
    sheetIs("SUBMITTED", ME);

    const res = await POST(req({ action: "submit" }), { params });

    expect(res.status).toBe(409);
    expect(applyTimesheetTransition).not.toHaveBeenCalled();
  });
});

describe("POST /timesheets/[id] — approve", () => {
  it("a manager may approve their report's week", async () => {
    sheetIs("SUBMITTED", THEM);
    isManagerOf.mockResolvedValue(true);

    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(200);
    expect(applyTimesheetTransition).toHaveBeenCalledWith(
      expect.objectContaining({ next: "APPROVED", lane: "labor" }),
    );
  });

  it("a plain member may not approve anyone", async () => {
    sheetIs("SUBMITTED", THEM);

    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(403);
    expect(applyTimesheetTransition).not.toHaveBeenCalled();
  });

  it("TIME_APPROVE is enough without being the manager", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_APPROVE")));
    sheetIs("SUBMITTED", THEM);

    expect((await POST(req({ action: "approve" }), { params })).status).toBe(200);
  });

  it("SELF-approval is refused when the person has a supervisor", async () => {
    // Even holding TIME_APPROVE: someone else is designated, and approving your
    // own hours bypasses them.
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_APPROVE")));
    sheetIs("SUBMITTED", ME);
    hasManager.mockResolvedValue(true);

    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(403);
    expect(applyTimesheetTransition).not.toHaveBeenCalled();
  });

  it("self-approval IS allowed with no supervisor — otherwise it deadlocks", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_APPROVE")));
    sheetIs("SUBMITTED", ME);
    hasManager.mockResolvedValue(false);

    expect((await POST(req({ action: "approve" }), { params })).status).toBe(200);
  });

  it("an unsubmitted week cannot be approved", async () => {
    sheetIs("OPEN", THEM);
    isManagerOf.mockResolvedValue(true);

    expect((await POST(req({ action: "approve" }), { params })).status).toBe(409);
  });
});

describe("POST /timesheets/[id] — reject", () => {
  it("requires a reason", async () => {
    // A rejection the worker cannot act on is a dead end: they learn the week
    // came back but not what to change.
    sheetIs("SUBMITTED", THEM);
    isManagerOf.mockResolvedValue(true);

    const res = await POST(req({ action: "reject" }), { params });

    expect(res.status).toBe(400);
    expect(applyTimesheetTransition).not.toHaveBeenCalled();
  });

  it("returns the week with the reason attached", async () => {
    sheetIs("SUBMITTED", THEM);
    isManagerOf.mockResolvedValue(true);

    const res = await POST(
      req({ action: "reject", reason: "Thursday looks like a duplicate" }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(applyTimesheetTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        next: "REJECTED",
        rejectedReason: "Thursday looks like a duplicate",
      }),
    );
  });

  it("an APPROVED week cannot be rejected", async () => {
    sheetIs("APPROVED", THEM);
    isManagerOf.mockResolvedValue(true);

    const res = await POST(req({ action: "reject", reason: "changed my mind" }), {
      params,
    });

    expect(res.status).toBe(409);
  });
});

/**
 * Withdrawing is the worker taking their OWN submission back, and it is NOT a
 * rejection — sharing that path would stamp a rejection reason on a week
 * nobody rejected, and read to everyone as "your supervisor bounced this".
 */
describe("POST /timesheets/[id] — withdraw", () => {
  function sheetWith(over: Record<string, unknown>) {
    prisma.timesheet.findFirst.mockResolvedValue({
      id: SHEET_ID,
      orgId: ORG_ID,
      userId: ME,
      status: "SUBMITTED",
      laborApprovedById: null,
      costApprovedById: null,
      ...over,
    });
  }

  it("the owner can take back a submitted week, returning it to OPEN", async () => {
    sheetWith({});

    const res = await POST(req({ action: "withdraw" }), { params });

    expect(res.status).toBe(200);
    expect(applyTimesheetTransition).toHaveBeenCalledWith(
      expect.objectContaining({ next: "OPEN", timesheetId: SHEET_ID }),
    );
  });

  it("never sets a rejection reason — that is the whole point", async () => {
    sheetWith({});

    await POST(req({ action: "withdraw" }), { params });

    const call = applyTimesheetTransition.mock.calls.at(-1)?.[0] as
      | { rejectedReason?: unknown }
      | undefined;
    expect(call?.rejectedReason).toBeUndefined();
  });

  it("you cannot withdraw SOMEONE ELSE's timesheet", async () => {
    // Not even an approver: returning someone's week is `reject`, which is
    // recorded as such and carries a reason they can act on.
    getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ", "TIME_APPROVE")));
    sheetWith({ userId: THEM });

    const res = await POST(req({ action: "withdraw" }), { params });

    expect(res.status).toBe(403);
    expect(applyTimesheetTransition).not.toHaveBeenCalled();
  });

  it("is refused once an approver has signed a lane", async () => {
    sheetWith({ laborApprovedById: THEM });

    const res = await POST(req({ action: "withdraw" }), { params });

    expect(res.status).toBe(409);
    expect(applyTimesheetTransition).not.toHaveBeenCalled();
  });

  it("a week that was never submitted has nothing to withdraw", async () => {
    sheetWith({ status: "OPEN" });

    expect((await POST(req({ action: "withdraw" }), { params })).status).toBe(409);
  });

  it("an APPROVED week cannot be withdrawn", async () => {
    sheetWith({ status: "APPROVED", laborApprovedById: THEM });

    expect((await POST(req({ action: "withdraw" }), { params })).status).toBe(409);
  });
});
