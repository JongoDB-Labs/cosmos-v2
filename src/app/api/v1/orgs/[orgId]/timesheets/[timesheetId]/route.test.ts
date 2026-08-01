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

const {
  getAuthContext,
  prisma,
  applyTimesheetTransition,
  isManagerOf,
  hasManager,
  resolveApprovalRoute,
  notifyTimesheetSubmitted,
  notifyTimesheetDecision,
} = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    timesheet: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
  },
  applyTimesheetTransition: vi.fn(),
  isManagerOf: vi.fn(),
  hasManager: vi.fn(),
  resolveApprovalRoute: vi.fn(),
  notifyTimesheetSubmitted: vi.fn(),
  notifyTimesheetDecision: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/time/timesheet-actions", () => ({
  applyTimesheetTransition,
  isManagerOf,
  hasManager,
}));
vi.mock("@/lib/time/routing", () => ({ resolveApprovalRoute }));
vi.mock("@/lib/time/notify", () => ({
  notifyTimesheetSubmitted,
  notifyTimesheetDecision,
}));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "44444444-4444-4444-4444-444444444444";
const THEM = "55555555-5555-5555-5555-555555555555";
const BOSS = "66666666-6666-6666-6666-666666666666";
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

const PERIOD_START = new Date("2026-07-27T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-02T00:00:00.000Z");

function sheetIs(status: string, userId = ME) {
  prisma.timesheet.findFirst.mockResolvedValue({
    id: SHEET_ID,
    orgId: ORG_ID,
    userId,
    status,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.user.findUnique.mockResolvedValue({ displayName: "Ada Lovelace" });
  // Honours the query: the route asks for the ROUTED approvers, so returning a
  // fixed name regardless of `where` would make the assertions below vacuous.
  prisma.user.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    (args.where.id.in ?? []).map((id: string) =>
      id === BOSS ? { displayName: "Grace Hopper" } : { displayName: "Ada Lovelace" },
    ),
  );
  getAuthContext.mockResolvedValue(ctxWith(bits("TIME_READ")));
  applyTimesheetTransition.mockResolvedValue({ id: SHEET_ID, status: "SUBMITTED" });
  isManagerOf.mockResolvedValue(false);
  hasManager.mockResolvedValue(false);
  resolveApprovalRoute.mockResolvedValue({
    approverId: BOSS,
    notify: [BOSS],
    reason: "manager",
  });
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

/**
 * Routing answers the worker's question — "who am I submitting this week TO?" —
 * which had no answer at all before: submitting flipped a status and told
 * nobody.
 */
describe("POST /timesheets/[id] — submit routes and notifies", () => {
  it("STAMPS the resolved approver on the sheet", async () => {
    // The stamp is the audit record of who it was handed to. Deriving it at
    // read time instead would let an org-chart change rewrite the history of a
    // closed period.
    sheetIs("OPEN", ME);

    await POST(req({ action: "submit" }), { params });

    expect(applyTimesheetTransition).toHaveBeenCalledWith(
      expect.objectContaining({ approverIds: [BOSS] }),
    );
  });

  it("stamps EVERY approver asked, not just one", async () => {
    // The pool case has no single approver, and a worker can have several
    // supervisors. Recording one of them would discard the record of who was
    // actually asked — the opposite of an audit trail.
    resolveApprovalRoute.mockResolvedValue({
      approverId: null,
      notify: [BOSS, THEM],
      reason: "admin_pool",
    });
    sheetIs("OPEN", ME);

    await POST(req({ action: "submit" }), { params });

    expect(applyTimesheetTransition).toHaveBeenCalledWith(
      expect.objectContaining({ approverIds: [BOSS, THEM] }),
    );
  });

  it("stamps an EMPTY set when nobody could approve it", async () => {
    // Written rather than skipped: a resubmission must not inherit the
    // approvers of a previous one.
    resolveApprovalRoute.mockResolvedValue({
      approverId: null,
      notify: [],
      reason: "none",
    });
    sheetIs("OPEN", ME);

    await POST(req({ action: "submit" }), { params });

    expect(applyTimesheetTransition).toHaveBeenCalledWith(
      expect.objectContaining({ approverIds: [] }),
    );
  });

  it("notifies the approver, with the period the sheet actually covers", async () => {
    sheetIs("OPEN", ME);

    await POST(req({ action: "submit" }), { params });

    expect(notifyTimesheetSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        workerUserId: ME,
        workerName: "Ada Lovelace",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        route: expect.objectContaining({ notify: [BOSS] }),
      }),
    );
  });

  it("tells the worker WHO it went to in the response", async () => {
    sheetIs("OPEN", ME);

    const res = await POST(req({ action: "submit" }), { params });
    const body = await res.json();

    expect(body.routedTo).toEqual({
      reason: "manager",
      approverNames: ["Grace Hopper"],
    });
  });

  it("says so plainly when NOBODY can approve the week", async () => {
    // The top of an org chart, or an org of one. Submission still succeeds —
    // blocking it would strand the hours — but the response must not imply
    // somebody was asked.
    resolveApprovalRoute.mockResolvedValue({
      approverId: null,
      notify: [],
      reason: "none",
    });
    sheetIs("OPEN", ME);

    const res = await POST(req({ action: "submit" }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.routedTo.reason).toBe("none");
    expect(body.routedTo.approverNames).toEqual([]);
  });

  it("does NOT route or notify when the submission is refused", async () => {
    sheetIs("SUBMITTED", ME);

    await POST(req({ action: "submit" }), { params });

    expect(notifyTimesheetSubmitted).not.toHaveBeenCalled();
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
 * The other half of the loop. A worker whose week was returned previously found
 * out only by revisiting the page — and a rejection nobody sees is a week that
 * never gets resubmitted.
 */
describe("POST /timesheets/[id] — the worker is told the outcome", () => {
  it("notifies the worker when their week is approved", async () => {
    sheetIs("SUBMITTED", THEM);
    isManagerOf.mockResolvedValue(true);

    await POST(req({ action: "approve" }), { params });

    expect(notifyTimesheetDecision).toHaveBeenCalledWith(
      expect.objectContaining({ workerUserId: THEM, decision: "approved" }),
    );
  });

  it("notifies the worker on a return, carrying the reason", async () => {
    sheetIs("SUBMITTED", THEM);
    isManagerOf.mockResolvedValue(true);

    await POST(
      req({ action: "reject", reason: "Thursday looks like a duplicate" }),
      { params },
    );

    expect(notifyTimesheetDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        workerUserId: THEM,
        decision: "rejected",
        reason: "Thursday looks like a duplicate",
      }),
    );
  });

  // NOT TESTED HERE, deliberately: the route only announces "approved" when the
  // transition lands on APPROVED, so that a two-lane org does not tell a worker
  // their week is approved while the cost lane can still reject it. With
  // LANE_CONFIG.requireCostApproval false that branch is unreachable through
  // this route, and a test that pretended to exercise it would be vacuous.
  // Enabling the cost lane must come with a test that a LABOR_APPROVED
  // transition notifies nobody.

  it("does NOT notify when the approval was refused", async () => {
    sheetIs("SUBMITTED", THEM); // caller is a plain member — no authority

    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(403);
    expect(notifyTimesheetDecision).not.toHaveBeenCalled();
  });

  it("does NOT notify when a withdrawal happens — nobody decided anything", async () => {
    sheetIs("SUBMITTED", ME);

    await POST(req({ action: "withdraw" }), { params });

    expect(notifyTimesheetDecision).not.toHaveBeenCalled();
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
