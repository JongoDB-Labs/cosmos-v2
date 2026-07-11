// @vitest-environment node
//
// Reorder ("arrange") + RBAC for the personal Home-dashboard widgets route.
// The reorder path (PATCH) is what lets a user *arrange* their widgets — the
// acceptance criterion that was missing before COSMOS-63. Proves:
//   - 401 with no auth context, 404 for an unknown org;
//   - a valid reorder renumbers sortOrder to match the incoming id order;
//   - only the caller's OWN widgets are renumbered — foreign ids are ignored
//     (a user can't reshuffle someone else's dashboard);
//   - a malformed body (non-uuid id) ⇒ 400, no DB writes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    homeWidget: { findMany: vi.fn(), update: vi.fn() },
    // The route wraps the per-widget updates in a transaction; execute the
    // array of update promises the same way Prisma does.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { PATCH } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "44444444-4444-4444-4444-444444444444";
// RFC-valid v4 UUIDs (version nibble 4, variant nibble 8) — zod's .uuid() enforces it.
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const W3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOREIGN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const params = Promise.resolve({ orgId: ORG_ID });

function ctx(perms: bigint): AuthContext {
  return {
    userId: USER_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/home-widgets`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.homeWidget.update.mockImplementation((arg: unknown) => Promise.resolve(arg));
});

describe("home-widgets PATCH — auth", () => {
  it("401 when there's no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await PATCH(patch({ orderedIds: [W1, W2] }), { params });
    expect(res.status).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("404 when the org does not exist", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    getAuthContext.mockResolvedValue(ctx(Permission.ORG_READ));
    const res = await PATCH(patch({ orderedIds: [W1, W2] }), { params });
    expect(res.status).toBe(404);
  });
});

describe("home-widgets PATCH — reorder", () => {
  beforeEach(() => {
    getAuthContext.mockResolvedValue(ctx(Permission.ORG_READ));
  });

  it("renumbers sortOrder to match the incoming id order", async () => {
    prisma.homeWidget.findMany.mockResolvedValue([
      { id: W1 },
      { id: W2 },
      { id: W3 },
    ]);
    // Send them in a new order: W3, W1, W2.
    const res = await PATCH(patch({ orderedIds: [W3, W1, W2] }), { params });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reordered: 3 });

    // Each widget is renumbered to its position in the requested order.
    const updates = prisma.homeWidget.update.mock.calls.map((c) => c[0]);
    expect(updates).toEqual([
      { where: { id: W3 }, data: { sortOrder: 0 } },
      { where: { id: W1 }, data: { sortOrder: 1 } },
      { where: { id: W2 }, data: { sortOrder: 2 } },
    ]);
    // Ownership scoping is enforced in the lookup query.
    expect(prisma.homeWidget.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, ownerId: USER_ID, id: { in: [W3, W1, W2] } },
      select: { id: true },
    });
  });

  it("ignores ids that aren't the caller's own widgets", async () => {
    // The DB only returns the caller's widgets; FOREIGN belongs to someone else.
    prisma.homeWidget.findMany.mockResolvedValue([{ id: W1 }, { id: W2 }]);
    const res = await PATCH(patch({ orderedIds: [FOREIGN, W2, W1] }), { params });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reordered: 2 });

    const updates = prisma.homeWidget.update.mock.calls.map((c) => c[0]);
    // FOREIGN is skipped; the survivors are renumbered by their filtered index.
    expect(updates).toEqual([
      { where: { id: W2 }, data: { sortOrder: 0 } },
      { where: { id: W1 }, data: { sortOrder: 1 } },
    ]);
    expect(
      updates.some((u) => u.where.id === FOREIGN),
    ).toBe(false);
  });

  it("400 on a malformed (non-uuid) id ⇒ no DB writes", async () => {
    const res = await PATCH(patch({ orderedIds: ["not-a-uuid"] }), { params });
    expect(res.status).toBe(400);
    expect(prisma.homeWidget.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("400 on an empty orderedIds array", async () => {
    const res = await PATCH(patch({ orderedIds: [] }), { params });
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
