// @vitest-environment node
//
// Approving time is a supervisor's decision, and supervising someone is a ROLE:
// approvalAuthority lets a manager of the subject approve without TIME_APPROVE.
// An API key carries its minter's role, so a time:write key minted by a
// supervisor could approve or reject its reports' timesheets and time off. The
// role now counts for a key only when its scopes grant TIME_APPROVE (none do).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG = "11111111-1111-4111-8111-111111111111";
const BOSS = "88888888-8888-4888-8888-888888888888";
const REPORT = "77777777-7777-4777-8777-777777777777";

const h = vi.hoisted(() => ({ getAuthContext: vi.fn(), writes: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
// The caller supervises the subject; the subject has a supervisor.
vi.mock("@/lib/time/timesheet-actions", async (orig) => ({
  ...(await orig<typeof import("@/lib/time/timesheet-actions")>()),
  isManagerOf: async () => true,
  hasManager: async () => true,
  applyTimesheetTransition: async () => { h.writes.push("timesheet.transition"); return { id: "t1" }; },
}));
vi.mock("@/lib/time/notify", () => ({ notifyTimesheetSubmitted: async () => {}, notifyTimesheetDecision: async () => {} }));
vi.mock("@/lib/audit", () => ({ logAudit: async () => {} }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: ORG, slug: "acme" }) },
    timesheet: { findFirst: async () => ({ id: "t1", orgId: ORG, userId: REPORT, status: "SUBMITTED", periodStart: new Date(), periodEnd: new Date() }) },
    timeOffRequest: {
      findFirst: async () => ({ id: "r1", userId: REPORT, status: "PENDING" }),
      update: async () => { h.writes.push("timeOff.update"); return { id: "r1", userId: REPORT, status: "APPROVED" }; },
    },
  },
}));

import { POST as decideTimesheet } from "@/app/api/v1/orgs/[orgId]/timesheets/[timesheetId]/route";
import { PATCH as decideTimeOff } from "@/app/api/v1/orgs/[orgId]/time-off/[requestId]/route";

// What a supervisor holds (no TIME_APPROVE: they approve by supervising).
const TIME = Permission.TIME_READ | Permission.TIME_CREATE | Permission.TIME_UPDATE;
const supervisor = (key: boolean): AuthContext => ({
  userId: BOSS, orgId: ORG, orgRole: OrgRole.MEMBER, permissions: TIME, basePermissions: TIME, abacRules: [],
  ...(key ? { isApiKey: true, scopes: ["time:write"] } : {}),
});
const post = (handler: typeof decideTimesheet, body: unknown, extra: Record<string, string>) =>
  (handler as unknown as (r: NextRequest, c: unknown) => Promise<Response>)(
    new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ orgId: ORG, ...extra }) },
  );

beforeEach(() => { vi.clearAllMocks(); h.writes.length = 0; });

describe("a supervisor's time:write key can't decide their reports' time", () => {
  it.each(["approve", "reject"])("timesheet %s is a 403, and nothing is written", async (action) => {
    h.getAuthContext.mockResolvedValue(supervisor(true));
    expect((await post(decideTimesheet, { action }, { timesheetId: "t1" })).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it.each(["approve", "deny"])("time-off %s is a 403, and nothing is written", async (action) => {
    h.getAuthContext.mockResolvedValue(supervisor(true));
    expect((await post(decideTimeOff as never, { action }, { requestId: "r1" })).status).toBe(403);
    expect(h.writes).toEqual([]);
  });
});

describe("the supervisor's browser session still decides", () => {
  it("approves the timesheet", async () => {
    h.getAuthContext.mockResolvedValue(supervisor(false));
    expect((await post(decideTimesheet, { action: "approve" }, { timesheetId: "t1" })).status).not.toBe(403);
    expect(h.writes).toContain("timesheet.transition");
  });

  it("approves the time off", async () => {
    h.getAuthContext.mockResolvedValue(supervisor(false));
    expect((await post(decideTimeOff as never, { action: "approve" }, { requestId: "r1" })).status).not.toBe(403);
    expect(h.writes).toContain("timeOff.update");
  });
});
