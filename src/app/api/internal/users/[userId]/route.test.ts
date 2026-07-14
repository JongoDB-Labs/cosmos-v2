// @vitest-environment node
//
// DELETE /api/internal/users/[userId] — platform-admin account deletion RBAC +
// guards. DB-free (prisma, the deleteUserAccount lib, requireSystemAdmin and
// logAudit are mocked). Proves:
//   - NON platform-admins (incl. a signed-in tenant admin) get 403;
//   - you can't delete your own account (403), a bot account (400), or an
//     already-deleted account (409);
//   - the SOLE owner of an org is blocked (409) — no orphaned org;
//   - the happy path runs deleteUserAccount + audits user.account_deleted once
//     per org the user belonged to, and returns the summary;
//   - a malformed / unknown user id is 404.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { requireSystemAdmin, deleteUserAccount, logAudit, prisma } = vi.hoisted(() => ({
  requireSystemAdmin: vi.fn(),
  deleteUserAccount: vi.fn(),
  logAudit: vi.fn(),
  prisma: {
    user: { findUnique: vi.fn() },
    orgMember: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("@/lib/internal/require-system-admin", () => ({ requireSystemAdmin }));
vi.mock("@/lib/internal/delete-user", () => ({ deleteUserAccount }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { DELETE } from "./route";

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_ID = "22222222-2222-2222-2222-222222222222";
const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function del(userId: string) {
  return new NextRequest(`http://localhost/api/internal/users/${userId}`, {
    method: "DELETE",
  });
}
const params = (userId: string) => ({ params: Promise.resolve({ userId }) });

// Owner-check + membership-capture both call orgMember.findMany; branch on the
// `role` filter so the target is a plain (non-owner) member of ORG_A by default.
function defaultFindMany(args: { where: { role?: string } }) {
  if (args.where.role === "OWNER") return Promise.resolve([]);
  return Promise.resolve([{ orgId: ORG_A }, { orgId: ORG_A }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSystemAdmin.mockResolvedValue({ id: ADMIN_ID, email: "admin@platform.com" });
  prisma.user.findUnique.mockResolvedValue({
    id: TARGET_ID,
    email: "target@acme.com",
    isBot: false,
    deactivatedAt: null,
  });
  prisma.orgMember.findMany.mockImplementation(defaultFindMany);
  prisma.orgMember.count.mockResolvedValue(2);
  deleteUserAccount.mockResolvedValue({
    userId: TARGET_ID,
    originalEmail: "target@acme.com",
    sentinelEmail: `deleted-${TARGET_ID}@deleted.invalid`,
    sessionsRevoked: 1,
    membershipsRemoved: 1,
    federatedIdentitiesRemoved: 0,
    pushSubscriptionsRemoved: 0,
    allowlistEntriesRemoved: 1,
    invitationsRemoved: 0,
  });
  logAudit.mockResolvedValue(undefined);
});

describe("platform-admin gate", () => {
  it("403 when the caller is not a platform admin", async () => {
    requireSystemAdmin.mockResolvedValue(null);
    const res = await DELETE(del(TARGET_ID), params(TARGET_ID));
    expect(res.status).toBe(403);
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });
});

describe("guards", () => {
  it("403 when deleting your own account", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: ADMIN_ID,
      email: "admin@platform.com",
      isBot: false,
      deactivatedAt: null,
    });
    const res = await DELETE(del(ADMIN_ID), params(ADMIN_ID));
    expect(res.status).toBe(403);
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });

  it("400 when the target is a bot account", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: TARGET_ID,
      email: "bot@acme.com",
      isBot: true,
      deactivatedAt: null,
    });
    const res = await DELETE(del(TARGET_ID), params(TARGET_ID));
    expect(res.status).toBe(400);
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });

  it("409 when the account was already deleted (idempotency)", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: TARGET_ID,
      email: "target@acme.com",
      isBot: false,
      deactivatedAt: new Date(),
    });
    const res = await DELETE(del(TARGET_ID), params(TARGET_ID));
    expect(res.status).toBe(409);
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });

  it("409 when the target is the SOLE owner of an org", async () => {
    prisma.orgMember.findMany.mockImplementation((args: { where: { role?: string } }) => {
      if (args.where.role === "OWNER")
        return Promise.resolve([{ orgId: ORG_A, org: { name: "Acme" } }]);
      return Promise.resolve([{ orgId: ORG_A }]);
    });
    prisma.orgMember.count.mockResolvedValue(1); // only owner
    const res = await DELETE(del(TARGET_ID), params(TARGET_ID));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Acme");
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });

  it("proceeds when the target is an owner but NOT the sole owner", async () => {
    prisma.orgMember.findMany.mockImplementation((args: { where: { role?: string } }) => {
      if (args.where.role === "OWNER")
        return Promise.resolve([{ orgId: ORG_A, org: { name: "Acme" } }]);
      return Promise.resolve([{ orgId: ORG_A }]);
    });
    prisma.orgMember.count.mockResolvedValue(2); // co-owner exists
    const res = await DELETE(del(TARGET_ID), params(TARGET_ID));
    expect(res.status).toBe(200);
    expect(deleteUserAccount).toHaveBeenCalledTimes(1);
  });

  it("404 for a malformed user id (never reaches the DB)", async () => {
    const res = await DELETE(del("not-a-uuid"), params("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("404 when the user does not exist", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await DELETE(del(TARGET_ID), params(TARGET_ID));
    expect(res.status).toBe(404);
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });
});

describe("happy path", () => {
  it("deletes the account, audits once per org, returns the summary", async () => {
    const res = await DELETE(del(TARGET_ID), params(TARGET_ID));
    expect(res.status).toBe(200);

    expect(deleteUserAccount).toHaveBeenCalledWith({
      userId: TARGET_ID,
      email: "target@acme.com",
    });
    // Member of ORG_A (deduped) → exactly one audit row for that org.
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_A,
        userId: ADMIN_ID,
        action: "user.account_deleted",
        entity: "user",
        entityId: TARGET_ID,
        metadata: expect.objectContaining({ by: "platform_admin", targetEmail: "target@acme.com" }),
      }),
    );

    const body = (await res.json()) as { deactivated: boolean; email: string };
    expect(body.deactivated).toBe(true);
    expect(body.email).toBe("target@acme.com");
  });

  it("still succeeds (no audit rows) for a user with no memberships", async () => {
    prisma.orgMember.findMany.mockResolvedValue([]); // no owner rows, no memberships
    const res = await DELETE(del(TARGET_ID), params(TARGET_ID));
    expect(res.status).toBe(200);
    expect(deleteUserAccount).toHaveBeenCalledTimes(1);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
