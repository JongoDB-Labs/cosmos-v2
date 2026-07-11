// @vitest-environment node
//
// Regression coverage for COSMOS-99 (notifications feed improvements). The feed
// used to fetch an unbounded array and render only what fit in the dropdown.
// This locks the server side of the fix: cursor pagination + a total unread
// count on GET, a category type-filter, and a clear-all DELETE — all scoped to
// the caller's own notifications.
//
// Harness mirrors the sibling comments route test: mock the I/O boundaries
// (session, prisma), let the pure RBAC check run, and call the exported
// handlers directly with the App-Router params Promise.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET, DELETE } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

function makeNotif(i: number) {
  return {
    id: `n${i}`,
    orgId: ORG_ID,
    userId: ACTOR_ID,
    type: "comment.added",
    title: `Notif ${i}`,
    body: "",
    refType: null,
    refId: null,
    read: false,
    url: null,
    createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
  };
}

const params = Promise.resolve({ orgId: ORG_ID });

function getReq(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/o/notifications${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith(bits("NOTIFICATION_READ")));
});

describe("GET /notifications", () => {
  it("paginates: trims the extra look-ahead row and returns a nextCursor", async () => {
    // limit=2 → the handler asks for 3; we return 3 so a next page exists.
    prisma.notification.findMany.mockResolvedValue([
      makeNotif(3),
      makeNotif(2),
      makeNotif(1),
    ]);
    prisma.notification.count.mockResolvedValue(2);

    const res = await GET(getReq("?limit=2"), { params });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(2);
    expect(body.items.map((n: { id: string }) => n.id)).toEqual(["n3", "n2"]);
    expect(body.nextCursor).toBe("n2");
    expect(body.unreadCount).toBe(2);

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.take).toBe(3); // limit + 1 look-ahead
    expect(args.where).toMatchObject({ orgId: ORG_ID, userId: ACTOR_ID });
  });

  it("returns a null nextCursor when there is no further page", async () => {
    prisma.notification.findMany.mockResolvedValue([makeNotif(2), makeNotif(1)]);
    prisma.notification.count.mockResolvedValue(0);

    const res = await GET(getReq("?limit=5"), { params });
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it("applies a category type-filter to the query", async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await GET(getReq("?category=comment"), { params });
    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where.type).toEqual({ startsWith: "comment." });
  });

  it("uses a cursor for subsequent pages and skips the unread count then", async () => {
    prisma.notification.findMany.mockResolvedValue([makeNotif(1)]);

    const res = await GET(getReq("?cursor=n2&limit=5"), { params });
    const body = await res.json();

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.cursor).toEqual({ id: "n2" });
    expect(args.skip).toBe(1);
    // The badge count is only computed for the first page.
    expect(prisma.notification.count).not.toHaveBeenCalled();
    expect(body.unreadCount).toBeNull();
  });

  it("rejects a caller without NOTIFICATION_READ", async () => {
    getAuthContext.mockResolvedValue(ctxWith(0n));
    const res = await GET(getReq(), { params });
    expect(res.status).toBe(403);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /notifications (clear all)", () => {
  it("clears the caller's whole feed and returns the count", async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 7 });

    const res = await DELETE(getReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(7);

    const args = prisma.notification.deleteMany.mock.calls[0][0];
    expect(args.where).toEqual({ orgId: ORG_ID, userId: ACTOR_ID });
  });

  it("respects an active category so only that slice is cleared", async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 2 });

    await DELETE(getReq("?category=mention"), { params });
    const args = prisma.notification.deleteMany.mock.calls[0][0];
    expect(args.where).toEqual({
      orgId: ORG_ID,
      userId: ACTOR_ID,
      type: { endsWith: ".mentioned" },
    });
  });

  it("rejects a caller without NOTIFICATION_READ", async () => {
    getAuthContext.mockResolvedValue(ctxWith(0n));
    const res = await DELETE(getReq(), { params });
    expect(res.status).toBe(403);
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
  });
});
