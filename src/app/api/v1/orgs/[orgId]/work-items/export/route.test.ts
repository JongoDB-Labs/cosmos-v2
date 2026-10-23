// @vitest-environment node
//
// Issues CSV export: classification handling. Mocks only the I/O boundaries
// (auth, prisma); scoping, the query projection, the classification resolver
// and the CSV writer all run for real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, type TenantClass, type ClassificationLevel } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findMany: vi.fn() },
    workItem: { findMany: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn() },
    dataClassification: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "44444444-4444-4444-8444-444444444444";
const P_PLAIN = "22222222-2222-4222-8222-222222222222";
const P_CUI = "33333333-3333-4333-8333-333333333333";

let n = 0;
function item(projectId: string, title: string, tags: string[] = []) {
  n += 1;
  return {
    id: `item-${n}`, ticketNumber: n, title, columnKey: "todo", priority: "MEDIUM",
    assigneeId: null, parentId: null, intervalId: null, storyPoints: null, tags,
    startDate: null, dueDate: null, completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
    projectId,
    workItemType: { id: "t", key: "task", name: "Task", icon: null, color: null },
  };
}

function setup(opts: {
  tenantClass: TenantClass;
  ceilings?: { projectId: string | null; level: ClassificationLevel }[];
  items: ReturnType<typeof item>[];
  orgExport?: boolean;
}) {
  prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme", tenantClass: opts.tenantClass });
  const perms = Permission.ITEM_READ | (opts.orgExport ? Permission.ORG_EXPORT : 0n);
  getAuthContext.mockResolvedValue({
    userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER,
    permissions: perms, basePermissions: perms, abacRules: [],
  } satisfies AuthContext);
  prisma.dataClassification.findMany.mockResolvedValue(opts.ceilings ?? []);
  prisma.workItem.findMany.mockResolvedValue(opts.items);
  prisma.workItem.count.mockResolvedValue(opts.items.length);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.project.findMany.mockImplementation(async (arg: { where?: { id?: { in?: string[] } } }) => {
    const all = [
      { id: P_PLAIN, key: "PLN", name: "Plain", teamScopedAccess: false },
      { id: P_CUI, key: "CUI", name: "Controlled", teamScopedAccess: false },
    ];
    const ids = arg?.where?.id?.in;
    return ids ? all.filter((p) => ids.includes(p.id)) : all;
  });
  prisma.user.findMany.mockResolvedValue([]);
  prisma.auditLog.create.mockResolvedValue({});
});

const req = () => new NextRequest(`http://localhost/api/v1/orgs/${ORG}/work-items/export`);
const params = Promise.resolve({ orgId: ORG });
const lines = async (res: Response) => (await res.text()).split("\n");

describe("GET /work-items/export — classification", () => {
  it("COMMERCIAL: no Classification column, no banner, never reads the ceilings", async () => {
    setup({ tenantClass: "COMMERCIAL", items: [item(P_CUI, "CUI roster")] });
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const [header] = await lines(res);
    expect(header).not.toContain("Classification");
    expect(header.startsWith("Ticket,")).toBe(true);
    expect(res.headers.get("X-Classification")).toBeNull();
    expect(prisma.dataClassification.findMany).not.toHaveBeenCalled();
  });

  it("GOV, nothing marked: per-row Unclassified column, no banner, no ORG_EXPORT needed", async () => {
    setup({ tenantClass: "GOV", items: [item(P_PLAIN, "Fix login")] });
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const [header, row] = await lines(res);
    expect(header.startsWith("Ticket,")).toBe(true);
    expect(header.endsWith(",Classification")).toBe(true);
    expect(row.endsWith(",Unclassified")).toBe(true);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("GOV, a CUI project without ORG_EXPORT → 403, nothing written or audited", async () => {
    setup({
      tenantClass: "GOV",
      ceilings: [{ projectId: P_CUI, level: "CUI" }],
      items: [item(P_PLAIN, "Fix login"), item(P_CUI, "Roster")],
    });
    const res = await GET(req(), { params });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Roster");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("GOV, a marked title in a plain project counts too (raised to CUI)", async () => {
    setup({ tenantClass: "GOV", items: [item(P_PLAIN, "CUI//SP-PRVCY roster")] });
    expect((await GET(req(), { params })).status).toBe(403);
  });

  it("GOV, a marked tag counts too", async () => {
    setup({ tenantClass: "GOV", items: [item(P_PLAIN, "Roster", ["FOUO"])] });
    expect((await GET(req(), { params })).status).toBe(403);
  });

  it("GOV with ORG_EXPORT: banner first and last, per-row levels, header, audit row", async () => {
    setup({
      tenantClass: "GOV",
      ceilings: [{ projectId: P_CUI, level: "CUI" }],
      items: [item(P_PLAIN, "Fix login"), item(P_CUI, "Roster")],
      orgExport: true,
    });
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Classification")).toBe("CUI");
    const out = await lines(res);
    expect(out[0]).toBe("CUI");
    expect(out.at(-1)).toBe("CUI");
    expect(out[1].startsWith("Ticket,")).toBe(true);
    expect(out[2].endsWith(",Unclassified")).toBe(true);
    expect(out[3].endsWith(",CUI")).toBe(true);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: ORG, userId: ME, action: "work_items.export.classified",
        metadata: { level: "CUI", rows: 2 },
      }),
    });
  });

  it("GOV org ceiling alone marks the whole file, even with no rows", async () => {
    setup({ tenantClass: "GOV", ceilings: [{ projectId: null, level: "CUI" }], items: [] });
    expect((await GET(req(), { params })).status).toBe(403);
  });
});
