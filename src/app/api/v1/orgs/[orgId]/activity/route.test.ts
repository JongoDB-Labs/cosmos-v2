import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, getReadableProjectIds, readableTimeUserIds } = vi.hoisted(
  () => ({
    prisma: {
      organization: { findUnique: vi.fn() },
      workItem: { findMany: vi.fn() },
      project: { findMany: vi.fn() },
      activity: { findMany: vi.fn() },
      timeEntry: { findMany: vi.fn() },
      user: { findMany: vi.fn() },
    },
    getAuthContext: vi.fn(),
    getReadableProjectIds: vi.fn(),
    readableTimeUserIds: vi.fn(),
  }),
);

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/work-items/query/scope", () => ({ getReadableProjectIds }));
vi.mock("@/lib/time/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/time/scope")>();
  return { ...actual, readableTimeUserIds: (...a: unknown[]) => readableTimeUserIds(...a) };
});

import { GET } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const REPORT = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";

const bits = (...k: PermissionKey[]) => k.reduce((a, x) => a | Permission[x], 0n);
const ctx = (...k: PermissionKey[]): AuthContext => {
  const permissions = bits(...k);
  return {
    userId: ME, orgId: ORG_ID, orgRole: OrgRole.MEMBER,
    permissions, basePermissions: permissions, abacRules: [],
  } as AuthContext;
};

const req = (qs = "") => new NextRequest(`http://localhost/api/v1/orgs/o/activity${qs}`);
const params = Promise.resolve({ orgId: ORG_ID });
const body = async (r: Response) => await r.json();

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  getAuthContext.mockResolvedValue(ctx("ITEM_READ", "TIME_READ"));
  getReadableProjectIds.mockResolvedValue([PROJECT]);
  readableTimeUserIds.mockResolvedValue([ME, REPORT]);
  prisma.workItem.findMany.mockResolvedValue([
    { id: "wi1", ticketNumber: 7, title: "A ticket", columnKey: "doing", projectId: PROJECT, workItemType: null },
  ]);
  prisma.project.findMany.mockResolvedValue([{ id: PROJECT, key: "P1", name: "A job" }]);
  prisma.activity.findMany.mockResolvedValue([
    { id: "a1", action: "updated", field: "status", oldValue: "x", newValue: "y",
      createdAt: new Date("2026-03-03T10:00:00.000Z"), userId: ME, workItemId: "wi1" },
  ]);
  prisma.timeEntry.findMany.mockResolvedValue([
    { id: "t1", userId: REPORT, date: new Date("2026-03-05T00:00:00.000Z"), hours: 6,
      description: "Detailing", billableType: "BILLABLE", projectId: PROJECT },
  ]);
  prisma.user.findMany.mockResolvedValue([
    { id: ME, displayName: "Me", avatarUrl: null },
    { id: REPORT, displayName: "Report", avatarUrl: null },
  ]);
});

describe("GET /orgs/[orgId]/activity — two sources", () => {
  it("interleaves logged time with work-item activity, newest first", async () => {
    const j = await body(await GET(req(), { params }));
    expect(j.data.map((r: { kind: string }) => r.kind)).toEqual(["time", "work-item"]);
    expect(j.data[0].time).toMatchObject({ hours: 6, date: "2026-03-05" });
  });

  it("gives somebody with only TIME_READ the time half and no trace of the other", async () => {
    getAuthContext.mockResolvedValue(ctx("TIME_READ"));
    const j = await body(await GET(req(), { params }));
    expect(j.data.every((r: { kind: string }) => r.kind === "time")).toBe(true);
    expect(prisma.activity.findMany).not.toHaveBeenCalled();
  });

  it("gives somebody with only ITEM_READ the work half and never reads time", async () => {
    getAuthContext.mockResolvedValue(ctx("ITEM_READ"));
    const j = await body(await GET(req(), { params }));
    expect(j.data.every((r: { kind: string }) => r.kind === "work-item")).toBe(true);
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
  });

  it("refuses only somebody who could read neither half", async () => {
    getAuthContext.mockResolvedValue(ctx("ORG_READ"));
    expect((await GET(req(), { params })).status).toBe(403);
  });

  it("still shows time to somebody with no readable projects at all", async () => {
    // The old feed returned empty here, which would now hide a whole source.
    getReadableProjectIds.mockResolvedValue([]);
    const j = await body(await GET(req(), { params }));
    expect(j.data.map((r: { kind: string }) => r.kind)).toEqual(["time"]);
  });
});

describe("whose time reaches the feed", () => {
  it("narrows to the people this actor may read", async () => {
    await GET(req(), { params });
    expect(prisma.timeEntry.findMany.mock.calls[0][0].where.userId).toEqual({
      in: [ME, REPORT],
    });
  });

  it("does not constrain for somebody who may read everybody", async () => {
    readableTimeUserIds.mockResolvedValue(null);
    await GET(req(), { params });
    expect(prisma.timeEntry.findMany.mock.calls[0][0].where.userId).toBeUndefined();
  });

  it("returns no time at all when asked about somebody unreadable", async () => {
    const j = await body(await GET(req(`?userId=${STRANGER}`), { params }));
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
    expect(j.data.every((r: { kind: string }) => r.kind !== "time")).toBe(true);
  });

  it("leaves out voided and un-submitted entries", async () => {
    await GET(req(), { params });
    const where = prisma.timeEntry.findMany.mock.calls[0][0].where;
    expect(where.voidedAt).toBeNull();
    expect(where.status).toEqual({ not: "DRAFT" });
  });
});

describe("filters", () => {
  it("excludes time when asked to filter by work-item type", async () => {
    // A type is a work-item notion; silently ignoring it would show time rows
    // that do not match the filter the reader set.
    await GET(req("?type=bug"), { params });
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
  });

  it("passes a project filter to both sources", async () => {
    await GET(req(`?projectId=${PROJECT}`), { params });
    expect(prisma.timeEntry.findMany.mock.calls[0][0].where.projectId).toBe(PROJECT);
    expect(prisma.workItem.findMany.mock.calls[0][0].where.projectId).toEqual({ in: [PROJECT] });
  });

  it("can be asked for one source only", async () => {
    await GET(req("?sources=time"), { params });
    expect(prisma.activity.findMany).not.toHaveBeenCalled();
    expect(prisma.timeEntry.findMany).toHaveBeenCalled();
  });

  it("hands back a composite cursor when there is another page", async () => {
    const j = await body(await GET(req("?limit=1"), { params }));
    expect(j.data).toHaveLength(1);
    expect(j.nextCursor).toBe("2026-03-05T00:00:00.000Z|t1");
  });
});
