// @vitest-environment node
//
// RBAC for the PLATFORM-OWNER billing-plan route. Proves:
//   - a NON-internal-admin (incl. a tenant-admin) gets 403 — plan is NOT
//     org-owner self-service;
//   - a platform-owner may set a valid plan (BASIC/TEAM/ENTERPRISE) and it
//     audits plan.changed with from/to;
//   - an invalid plan value is rejected 400.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getCurrentUser, isInternalAdmin, prisma, logAudit } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isInternalAdmin: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser }));
vi.mock("@/lib/internal/access", () => ({ isInternalAdmin }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { PATCH } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/internal/orgs/${ORG_ID}/plan`, {
    method: "PATCH", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, plan: "BASIC" });
  prisma.organization.update.mockResolvedValue({ id: ORG_ID, plan: "ENTERPRISE" });
});

describe("PATCH plan — platform-owner RBAC", () => {
  it("403 when the caller is NOT signed in", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await PATCH(patch({ plan: "ENTERPRISE" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.organization.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("403 for a tenant-admin (signed in but NOT an internal admin) — cannot change plan", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", email: "admin@tenant.com" });
    isInternalAdmin.mockReturnValue(false);
    const res = await PATCH(patch({ plan: "ENTERPRISE" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.organization.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("PATCH plan — platform-owner can change the plan", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: "owner-1", email: "owner@platform.com" });
    isInternalAdmin.mockReturnValue(true);
  });

  it("sets a valid plan ⇒ organization.update + plan.changed audited with from/to", async () => {
    const res = await PATCH(patch({ plan: "ENTERPRISE" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { plan: "ENTERPRISE" },
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "plan.changed",
        metadata: expect.objectContaining({ from: "BASIC", to: "ENTERPRISE", by: "platform_owner" }),
      }),
    );
  });

  it("accepts every value in the new enum (TEAM)", async () => {
    const res = await PATCH(patch({ plan: "TEAM" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { plan: "TEAM" },
    });
  });

  it("400 on an invalid plan value (a removed legacy tier)", async () => {
    const res = await PATCH(patch({ plan: "GOV" }), { params });
    expect(res.status).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });
});
