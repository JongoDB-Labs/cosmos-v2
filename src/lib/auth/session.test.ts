// @vitest-environment node
//
// revokeOrgSessions — terminates all sessions for an org's members. Locks the
// behavior the security-settings PUT relies on when a GOV org tightens posture.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    orgMember: { findMany: vi.fn() },
    session: { deleteMany: vi.fn() },
    sessionRecord: { updateMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
// session.ts imports next/headers + rbac at module top — stub them so the node
// test env can import the module without a request context.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("react", () => ({ cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/rbac/effective-permissions", () => ({
  loadEffectivePermissions: vi.fn(),
}));

import { revokeOrgSessions } from "./session";

const ORG_ID = "00000000-0000-0000-0000-0000000000aa";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.session.deleteMany.mockResolvedValue({ count: 0 });
  prisma.sessionRecord.updateMany.mockResolvedValue({ count: 0 });
});

describe("revokeOrgSessions", () => {
  it("deletes Session rows for every member and revokes the org's SessionRecords", async () => {
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: "u1" },
      { userId: "u2" },
    ]);
    prisma.session.deleteMany.mockResolvedValue({ count: 3 });

    const count = await revokeOrgSessions(ORG_ID);

    expect(count).toBe(3);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: { in: ["u1", "u2"] } },
    });
    expect(prisma.sessionRecord.updateMany).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, status: "ACTIVE" },
      data: expect.objectContaining({ status: "REVOKED" }),
    });
  });

  it("no-ops (no deletes) when the org has no members", async () => {
    prisma.orgMember.findMany.mockResolvedValue([]);
    const count = await revokeOrgSessions(ORG_ID);
    expect(count).toBe(0);
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
    expect(prisma.sessionRecord.updateMany).not.toHaveBeenCalled();
  });
});
