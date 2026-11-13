// @vitest-environment node
//
// orgRequiresSso — whether an org opens only to its own IdP's sessions. A
// property of the ORG, checked where the org is opened (getAuthContext, via
// org-session-scope), never at sign-in: the person's other orgs keep working.
// Only a GOV org whose connection is both enabled and enforced requires it.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { idpConnection: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/db/client", () => ({ prisma }));

import { orgRequiresSso } from "./sso-enforcement";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.idpConnection.findUnique.mockResolvedValue(null);
});

describe("orgRequiresSso", () => {
  it("requires SSO for a GOV org whose connection is enabled and enforced", async () => {
    prisma.idpConnection.findUnique.mockResolvedValue({ enabled: true, enforced: true });
    expect(await orgRequiresSso({ id: "o1", tenantClass: "GOV" })).toBe(true);
    expect(prisma.idpConnection.findUnique.mock.calls[0][0].where).toEqual({ orgId: "o1" });
  });

  it("does not for a GOV org whose connection is disabled, or not enforced, or missing", async () => {
    for (const conn of [{ enabled: false, enforced: true }, { enabled: true, enforced: false }, null]) {
      prisma.idpConnection.findUnique.mockResolvedValue(conn);
      expect(await orgRequiresSso({ id: "o1", tenantClass: "GOV" })).toBe(false);
    }
  });

  it("never for a commercial org, even with an enforced connection, and without asking the database", async () => {
    prisma.idpConnection.findUnique.mockResolvedValue({ enabled: true, enforced: true });
    expect(await orgRequiresSso({ id: "o2", tenantClass: "COMMERCIAL" })).toBe(false);
    expect(prisma.idpConnection.findUnique).not.toHaveBeenCalled();
  });
});
