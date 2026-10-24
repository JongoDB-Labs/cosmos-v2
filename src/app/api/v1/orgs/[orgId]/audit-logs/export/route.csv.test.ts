// @vitest-environment node
//
// COSMOS-200: the audit-log CSV was hand-joined, with no quoting and no formula
// guard. `ipAddress` can come from a request header, so a crafted value ran as
// a formula in whoever opened the export, and a comma in any field shifted
// every column after it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { parseCSV } from "@/lib/export/csv";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => ({ userId: "u1", orgId: "o1" })) }));
vi.mock("@/lib/rbac/check", () => ({ requirePermission: vi.fn() }));
vi.mock("@/lib/pdf/audit-log", () => ({ generateAuditLogPdf: vi.fn() }));
vi.mock("@/lib/pdf/org-logo", () => ({ loadPdfLogo: vi.fn() }));

import { GET } from "./route";

const params = Promise.resolve({ orgId: "o1" });
const csvRequest = () =>
  new NextRequest("http://localhost/api/v1/orgs/o1/audit-logs/export?format=csv");

const LOG = {
  createdAt: new Date("2026-10-22T10:00:00.000Z"),
  userId: "u1",
  action: "work_item.updated",
  entity: "work_item",
  entityId: "id, with a comma",
  ipAddress: '=HYPERLINK("http://evil.example","x")',
  metadata: { field: "title" },
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: "o1", slug: "acme" });
});

describe("audit-log CSV export", () => {
  it("keeps the header and columns, quotes commas, and neutralizes formulas", async () => {
    prisma.auditLog.findMany.mockResolvedValue([LOG]);

    const text = await (await GET(csvRequest(), { params })).text();
    const { headers, rows } = parseCSV(text);

    expect(headers).toEqual(["timestamp", "userId", "action", "entity", "entityId", "ipAddress", "metadata"]);
    expect(rows[0].entityId).toBe("id, with a comma");
    expect(rows[0].ipAddress).toBe('\'=HYPERLINK("http://evil.example","x")');
    expect(JSON.parse(rows[0].metadata)).toEqual({ field: "title" });
  });

  it("still sends the header when there is nothing to export", async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);

    const text = await (await GET(csvRequest(), { params })).text();

    expect(text).toBe("timestamp,userId,action,entity,entityId,ipAddress,metadata");
  });
});
