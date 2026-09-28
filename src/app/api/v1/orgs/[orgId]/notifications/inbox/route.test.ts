import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, getAuthContext } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    notification: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { GET, POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";

const bits = (...k: PermissionKey[]) => k.reduce((a, x) => a | Permission[x], 0n);
const ctx = (...k: PermissionKey[]): AuthContext => {
  const permissions = bits(...k);
  return {
    userId: ME, orgId: ORG_ID, orgRole: OrgRole.MEMBER,
    permissions, basePermissions: permissions, abacRules: [],
  } as AuthContext;
};

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: "alerts.past_due", title: "Past due", body: "",
  url: null, refType: null, refId: null, read: false,
  createdAt: new Date("2026-03-01T00:00:00.000Z"), ...over,
});

const req = (qs = "") =>
  new NextRequest(`http://localhost/api/v1/orgs/o/notifications/inbox${qs}`);
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/orgs/o/notifications/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = Promise.resolve({ orgId: ORG_ID });
const json = async (r: Response) => await r.json();

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  getAuthContext.mockResolvedValue(ctx("NOTIFICATION_READ"));
  prisma.notification.findMany.mockResolvedValue([row("n1"), row("n2")]);
  prisma.notification.groupBy.mockResolvedValue([
    { type: "alerts.past_due", _count: { _all: 431 } },
    { type: "alerts.critical", _count: { _all: 24 } },
  ]);
  prisma.notification.count.mockResolvedValue(524);
  prisma.notification.updateMany.mockResolvedValue({ count: 431 });
});

describe("GET the inbox", () => {
  it("only ever reads this person's own", async () => {
    await GET(req(), { params });
    for (const call of prisma.notification.findMany.mock.calls) {
      expect(call[0].where).toMatchObject({ orgId: ORG_ID, userId: ME });
    }
  });

  it("counts the WHOLE inbox by kind, biggest first", async () => {
    const j = await json(await GET(req(), { params }));
    expect(j.counts.byType).toEqual([
      { type: "alerts.past_due", count: 431 },
      { type: "alerts.critical", count: 24 },
    ]);
  });

  it("does not let the type filter narrow the counts", async () => {
    // Otherwise picking a kind hides every other kind and there is no way back.
    await GET(req("?type=alerts.critical"), { params });
    expect(prisma.notification.groupBy.mock.calls[0][0].where.type).toBeUndefined();
    expect(prisma.notification.findMany.mock.calls[0][0].where.type).toBe(
      "alerts.critical",
    );
  });

  it("pages, and says when there is more", async () => {
    prisma.notification.findMany.mockResolvedValue([row("n1"), row("n2"), row("n3")]);
    const j = await json(await GET(req("?limit=2"), { params }));
    expect(j.data).toHaveLength(2);
    expect(j.nextCursor).toBe("2026-03-01T00:00:00.000Z");
  });

  it("has no cursor when the page was the lot", async () => {
    const j = await json(await GET(req("?limit=50"), { params }));
    expect(j.nextCursor).toBeNull();
  });

  it("refuses somebody who may not read notifications", async () => {
    getAuthContext.mockResolvedValue(ctx("ORG_READ"));
    expect((await GET(req(), { params })).status).toBe(403);
  });
});

describe("POST read-all", () => {
  it("marks only this person's unread", async () => {
    // The one mistake a bulk write here must not make.
    await POST(post({ action: "read-all" }), { params });
    expect(prisma.notification.updateMany.mock.calls[0][0].where).toEqual({
      orgId: ORG_ID,
      userId: ME,
      read: false,
    });
  });

  it("can clear one kind without clearing the rest", async () => {
    await POST(post({ action: "read-all", type: "alerts.past_due" }), { params });
    expect(prisma.notification.updateMany.mock.calls[0][0].where.type).toBe(
      "alerts.past_due",
    );
  });

  it("rejects an action it does not know", async () => {
    const res = await POST(post({ action: "delete-everything" }), { params });
    expect(res.status).toBe(400);
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("refuses somebody without the permission", async () => {
    getAuthContext.mockResolvedValue(ctx("ORG_READ"));
    expect((await POST(post({ action: "read-all" }), { params })).status).toBe(403);
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });
});
