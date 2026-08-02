// @vitest-environment node
//
// This endpoint exists so the Submit button can say where a week is about to
// go. Its one security property is that it is SELF-ONLY: "who approves Alice's
// time?" is an org-chart question this route deliberately cannot be made to
// answer, no matter what is put in the query string.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, resolveApprovalRoute, resolveSubmitGate } =
  vi.hoisted(() => ({
    getAuthContext: vi.fn(),
    prisma: {
      organization: { findUnique: vi.fn() },
      user: { findMany: vi.fn() },
    },
    resolveApprovalRoute: vi.fn(),
    resolveSubmitGate: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/time/routing", () => ({ resolveApprovalRoute }));
vi.mock("@/lib/time/submit-gate", () => ({ resolveSubmitGate }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "44444444-4444-4444-4444-444444444444";
const SOMEONE_ELSE = "55555555-5555-5555-5555-555555555555";
const BOSS = "66666666-6666-6666-6666-666666666666";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
const ctx: AuthContext = {
  userId: ME,
  orgId: ORG_ID,
  orgRole: OrgRole.MEMBER,
  permissions: bits("TIME_READ"),
  basePermissions: bits("TIME_READ"),
  abacRules: [],
};
const params = Promise.resolve({ orgId: ORG_ID });
const req = (qs = "") =>
  new NextRequest(`http://localhost/api/v1/orgs/o/time-entries/my-approvers${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctx);
  resolveApprovalRoute.mockResolvedValue({
    approverId: BOSS,
    notify: [BOSS],
    reason: "manager",
  });
  prisma.user.findMany.mockResolvedValue([{ displayName: "Grace Hopper" }]);
  resolveSubmitGate.mockResolvedValue({ allowed: true, eligible: [] });
});

describe("GET /time-entries/my-approvers", () => {
  it("answers for the SIGNED-IN user", async () => {
    const res = await GET(req(), { params });
    const body = await res.json();

    expect(resolveApprovalRoute).toHaveBeenCalledWith(ORG_ID, ME);
    expect(body).toEqual({
      reason: "manager",
      approverNames: ["Grace Hopper"],
      canSubmit: true,
      blockCode: null,
      eligibleSupervisors: [],
    });
  });

  it("IGNORES a userId in the query string", async () => {
    // Otherwise this becomes an org-chart lookup for anyone with TIME_READ.
    await GET(req(`?userId=${SOMEONE_ELSE}`), { params });

    expect(resolveApprovalRoute).toHaveBeenCalledWith(ORG_ID, ME);
    expect(resolveApprovalRoute).not.toHaveBeenCalledWith(ORG_ID, SOMEONE_ELSE);
  });

  it("returns NAMES only — never the approvers' user ids", async () => {
    // Every id withheld is one fewer handle on an org member, and the client
    // has no use for them.
    const res = await GET(req(), { params });
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain(BOSS);
  });

  it("reports 'none' with an empty list when nobody can approve", async () => {
    resolveApprovalRoute.mockResolvedValue({
      approverId: null,
      notify: [],
      reason: "none",
    });

    const res = await GET(req(), { params });
    const body = await res.json();

    expect(body).toEqual({
      reason: "none",
      approverNames: [],
      // ALLOWED, and that is the point: an org where nobody can approve is the
      // exemption, not the block. Refusing here would lock every worker out of
      // recording time with no fix available from inside the product.
      canSubmit: true,
      blockCode: null,
      eligibleSupervisors: [],
    });
    // No point querying for zero users.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("reports the BLOCK and who may be asked, so the client can act", async () => {
    // The blocked case is NOT `reason: "none"` — the two nearly invert each
    // other. Here approvers exist and none of them supervises this worker,
    // which is exactly what the gate refuses.
    resolveApprovalRoute.mockResolvedValue({
      approverId: null,
      notify: [BOSS],
      reason: "admin_pool",
    });
    resolveSubmitGate.mockResolvedValue({
      allowed: false,
      code: "SUPERVISOR_REQUIRED",
      reason: "You need a supervisor",
      eligible: [
        { employeeId: "emp-1", userId: BOSS, displayName: "Grace Hopper", canApprove: true },
      ],
    });

    const res = await GET(req(), { params });
    const body = await res.json();

    expect(body.canSubmit).toBe(false);
    // Matched on the code, never the prose — see lib/time/submit-gate.ts.
    expect(body.blockCode).toBe("SUPERVISOR_REQUIRED");
    expect(body.eligibleSupervisors).toEqual([
      { employeeId: "emp-1", displayName: "Grace Hopper" },
    ]);
  });

  it("does not leak candidate USER ids into the picker payload", async () => {
    // The candidate list is an org-chart answer. The client acts on employee
    // ids, so the user id is both unnecessary and one more handle on a member.
    resolveSubmitGate.mockResolvedValue({
      allowed: false,
      code: "SUPERVISOR_REQUIRED",
      eligible: [
        { employeeId: "emp-1", userId: BOSS, displayName: "Grace Hopper", canApprove: true },
      ],
    });

    const res = await GET(req(), { params });

    expect(JSON.stringify(await res.json())).not.toContain(BOSS);
  });

  it("requires TIME_READ", async () => {
    getAuthContext.mockResolvedValue({ ...ctx, permissions: 0n });

    const res = await GET(req(), { params });

    expect(res.status).toBe(403);
  });

  it("401s when signed out", async () => {
    getAuthContext.mockResolvedValue(null);

    expect((await GET(req(), { params })).status).toBe(401);
  });
});
