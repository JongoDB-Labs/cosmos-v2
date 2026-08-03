// @vitest-environment node
//
// Contracts on a project you cannot open must not be listed or fetched.
//
// `CRM_READ` is held by MEMBER and VIEWER, so it authorises reading SOME
// contracts and says nothing about WHICH. `Contract.projectId` is real (and
// nullable, with its own index), so an org-only filter exposed the terms and
// value of contracts attached to team-scoped projects.
//
// A contract with NO project is org-level CRM data and stays visible — that is
// how contracts are used today, and narrowing them away would be a different
// bug.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, getReadableProjectIds, isProjectVisible } =
  vi.hoisted(() => ({
    getAuthContext: vi.fn(),
    prisma: {
      organization: { findUnique: vi.fn() },
      contract: { findMany: vi.fn(), findFirst: vi.fn() },
    },
    getReadableProjectIds: vi.fn(),
    isProjectVisible: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/work-items/query/scope", () => ({ getReadableProjectIds }));
vi.mock("@/lib/rbac/project-access", () => ({ isProjectVisible }));

import { GET as listContracts } from "./route";
import { GET as getContract } from "./[contractId]/route";

const ORG_ID = "11111111-1111-4111-a111-111111111111";
const ME = "22222222-2222-4222-a222-222222222222";
const OPEN_PROJECT = "33333333-3333-4333-a333-333333333333";
const HIDDEN_PROJECT = "44444444-4444-4444-a444-444444444444";
const CONTRACT = "55555555-5555-4555-a555-555555555555";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
const ctx: AuthContext = {
  userId: ME,
  orgId: ORG_ID,
  orgRole: OrgRole.MEMBER,
  permissions: bits("CRM_READ"),
  basePermissions: bits("CRM_READ"),
  abacRules: [],
};
const listParams = Promise.resolve({ orgId: ORG_ID });
const detailParams = Promise.resolve({ orgId: ORG_ID, contractId: CONTRACT });
const req = (qs = "") =>
  new NextRequest(`http://localhost/api/v1/orgs/o/contracts${qs}`);

const lastWhere = () =>
  prisma.contract.findMany.mock.calls.at(-1)?.[0]?.where as Record<
    string,
    unknown
  >;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctx);
  getReadableProjectIds.mockResolvedValue([OPEN_PROJECT]);
  prisma.contract.findMany.mockResolvedValue([]);
  prisma.contract.findFirst.mockResolvedValue({
    id: CONTRACT,
    projectId: HIDDEN_PROJECT,
  });
  isProjectVisible.mockResolvedValue(false);
});

describe("GET /contracts — list", () => {
  it("narrows to readable projects, and keeps org-level contracts", async () => {
    await listContracts(req(), { params: listParams });

    expect(getReadableProjectIds).toHaveBeenCalled();
    expect(lastWhere().OR).toEqual([
      { projectId: null },
      { projectId: { in: [OPEN_PROJECT] } },
    ]);
  });

  it("keeps org-level contracts when NO project is readable", async () => {
    // Contracts are CRM data first; an empty readable set must not hide the
    // ones that belong to nobody's project.
    getReadableProjectIds.mockResolvedValue([]);

    await listContracts(req(), { params: listParams });

    expect(lastWhere().OR).toEqual([
      { projectId: null },
      { projectId: { in: [] } },
    ]);
  });
});

describe("GET /contracts/[contractId] — detail", () => {
  it("404s a contract on a project the caller cannot open", async () => {
    const res = await getContract(req(), { params: detailParams });

    expect(res.status).toBe(404);
  });

  it("does not distinguish hidden from missing", async () => {
    // A 403 here would confirm the contract exists inside a project they
    // cannot look at — the same contract every other scoped route keeps.
    const res = await getContract(req(), { params: detailParams });

    expect(res.status).not.toBe(403);
  });

  it("returns a contract with NO project", async () => {
    // Org-level CRM data: no project to gate on, so the CRM_READ check is the
    // whole rule.
    prisma.contract.findFirst.mockResolvedValue({ id: CONTRACT, projectId: null });

    const res = await getContract(req(), { params: detailParams });

    expect(res.status).toBe(200);
    expect(isProjectVisible).not.toHaveBeenCalled();
  });

  it("returns a contract on a project the caller CAN open", async () => {
    prisma.contract.findFirst.mockResolvedValue({
      id: CONTRACT,
      projectId: OPEN_PROJECT,
    });
    isProjectVisible.mockResolvedValue(true);

    const res = await getContract(req(), { params: detailParams });

    expect(res.status).toBe(200);
  });
});
