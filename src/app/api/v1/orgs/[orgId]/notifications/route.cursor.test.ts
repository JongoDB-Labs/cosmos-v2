// @vitest-environment node
//
// COSMOS-214 — the bell's feed pages back through history, so the collection
// endpoint has to accept a cursor. Same shape as ./inbox: the `createdAt` of
// the oldest row the caller already holds, exclusive.
//
// Harness follows work-items/search/route.test.ts: mock only the I/O boundaries
// (@/lib/auth/session, @/lib/db/client) and call the exported GET directly.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    notification: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

const ctx: AuthContext = {
  userId: USER_ID,
  orgId: ORG_ID,
  orgRole: OrgRole.MEMBER,
  permissions: Permission.NOTIFICATION_READ,
  basePermissions: Permission.NOTIFICATION_READ,
  abacRules: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctx);
  prisma.notification.findMany.mockResolvedValue([]);
});

function call(query: string) {
  return GET(
    new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/notifications${query}`),
    { params: Promise.resolve({ orgId: ORG_ID }) },
  );
}

const lastWhere = () => prisma.notification.findMany.mock.calls[0][0].where;

describe("GET /notifications cursor paging", () => {
  it("asks only for rows older than the cursor", async () => {
    const cursor = "2026-10-20T12:00:00.000Z";
    const res = await call(`?limit=25&cursor=${encodeURIComponent(cursor)}`);

    expect(res.status).toBe(200);
    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where.createdAt).toEqual({ lt: new Date(cursor) });
    expect(args.where.userId).toBe(USER_ID);
    expect(args.take).toBe(25);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("returns the newest page when no cursor is given", async () => {
    await call("?limit=25");
    expect(lastWhere().createdAt).toBeUndefined();
  });

  it("ignores an unparseable cursor rather than querying on NaN", async () => {
    // `new Date("not-a-date")` is an Invalid Date; handing that to Prisma throws.
    const res = await call("?limit=25&cursor=not-a-date");
    expect(res.status).toBe(200);
    expect(lastWhere().createdAt).toBeUndefined();
  });

  it("still answers a bare array with no params, for callers that page nothing", async () => {
    prisma.notification.findMany.mockResolvedValue([
      { id: "n1", type: "generic", title: "t", body: "b", read: false },
    ]);
    const res = await call("");
    expect(Array.isArray(await res.json())).toBe(true);
    expect(prisma.notification.findMany.mock.calls[0][0].take).toBeUndefined();
  });
});
