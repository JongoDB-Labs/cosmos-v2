// @vitest-environment node
//
// googleLoginBlockedByGovSso — the gov SSO-enforcement guard for the Google
// (non-SSO) login path. Locks the bypass fix: a GOV member of an enabled+
// enforced IdpConnection org must NOT be allowed to mint a session via Google,
// EXCEPT platform owners on INTERNAL_ADMINS (break-glass).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    orgMember: { findFirst: vi.fn() },
    invitation: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma }));

import { googleLoginBlockedByGovSso } from "./sso-enforcement";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.orgMember.findFirst.mockResolvedValue(null);
  prisma.invitation.findFirst.mockResolvedValue(null);
  delete process.env.INTERNAL_ADMINS;
});

afterEach(() => {
  delete process.env.INTERNAL_ADMINS;
});

describe("googleLoginBlockedByGovSso", () => {
  it("blocks a member of a GOV enabled+enforced SSO org", async () => {
    prisma.orgMember.findFirst.mockResolvedValue({ id: "m1" });
    const blocked = await googleLoginBlockedByGovSso({
      email: "alice@agency.gov",
      userId: "u1",
    });
    expect(blocked).toBe(true);
    // The org filter must require GOV + enabled + enforced.
    const where = prisma.orgMember.findFirst.mock.calls[0][0].where;
    expect(where.org.tenantClass).toBe("GOV");
    expect(where.org.idpConnection.is).toEqual({ enabled: true, enforced: true });
  });

  it("blocks an invited (not-yet-member) user of a GOV enforced org", async () => {
    prisma.invitation.findFirst.mockResolvedValue({ id: "i1" });
    const blocked = await googleLoginBlockedByGovSso({
      email: "bob@agency.gov",
      userId: null,
    });
    expect(blocked).toBe(true);
    expect(prisma.orgMember.findFirst).not.toHaveBeenCalled(); // no userId
  });

  it("allows a user with no gov-enforced membership or invite", async () => {
    const blocked = await googleLoginBlockedByGovSso({
      email: "carol@commercial.com",
      userId: "u2",
    });
    expect(blocked).toBe(false);
  });

  it("exempts INTERNAL_ADMINS platform owners (break-glass) without any DB hit", async () => {
    process.env.INTERNAL_ADMINS = "owner@cosmos.dev, admin@cosmos.dev";
    prisma.orgMember.findFirst.mockResolvedValue({ id: "m1" }); // would otherwise block
    const blocked = await googleLoginBlockedByGovSso({
      email: "Owner@Cosmos.dev", // case-insensitive
      userId: "u3",
    });
    expect(blocked).toBe(false);
    expect(prisma.orgMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.invitation.findFirst).not.toHaveBeenCalled();
  });
});
