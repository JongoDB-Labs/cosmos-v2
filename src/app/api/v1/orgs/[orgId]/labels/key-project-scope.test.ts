// @vitest-environment node
//
// Labels and custom fields are org-level, so the `read` scope reaching them
// (via PROJECT_READ for keys, #1135) must not carry a project-limited key past
// its ceiling: a key counts label usage only in the projects it can read, and
// sees only org-wide custom fields plus those of its projects. A browser
// session keeps the org-wide view it always had.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG = "11111111-1111-4111-8111-111111111111";
const P1 = "a1111111-1111-4111-8111-111111111111";
const P2 = "a2222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({ getAuthContext: vi.fn(), groupBy: vi.fn(), fields: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: ORG, slug: "acme" }) },
    project: {
      findMany: async () => [
        { id: P1, teamScopedAccess: false },
        { id: P2, teamScopedAccess: false },
      ],
    },
    label: { findMany: async () => [] },
    workItemLabel: { groupBy: (args: unknown) => { h.groupBy(args); return []; } },
    customField: { findMany: (args: unknown) => { h.fields(args); return []; } },
  },
}));

import { GET as listLabels } from "./route";
import { GET as listCustomFields } from "../custom-fields/route";

const READ = Permission.PROJECT_READ | Permission.ITEM_READ;
/** A key limited to P1, as apiKeyAuthContext builds it. */
const key = (): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole: OrgRole.MEMBER, permissions: READ, basePermissions: READ,
  abacRules: [], isApiKey: true, scopes: ["read"], projectScope: [P1],
});
const session = (): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole: OrgRole.MEMBER,
  permissions: READ | Permission.ORG_READ, basePermissions: READ | Permission.ORG_READ, abacRules: [],
});
const get = (handler: typeof listLabels, qs = "") =>
  handler(new NextRequest(`http://localhost/x${qs}`), { params: Promise.resolve({ orgId: ORG }) });
const where = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls[0][0] as { where: Record<string, unknown> }).where;

beforeEach(() => vi.clearAllMocks());

describe("labels: a project-limited key counts only its projects", () => {
  it("counts usage in P1 only", async () => {
    h.getAuthContext.mockResolvedValue(key());
    expect((await get(listLabels)).status).toBe(200);
    expect(where(h.groupBy)).toEqual({ orgId: ORG, workItem: { projectId: { in: [P1] } } });
  });

  it("asking for another project's counts gives none of them", async () => {
    h.getAuthContext.mockResolvedValue(key());
    expect((await get(listLabels, `?projectId=${P2}`)).status).toBe(200);
    expect(where(h.groupBy)).toEqual({ orgId: ORG, workItem: { projectId: { in: [] } } });
  });

  it("a session keeps the org-wide counts", async () => {
    h.getAuthContext.mockResolvedValue(session());
    await get(listLabels);
    expect(where(h.groupBy)).toEqual({ orgId: ORG });
  });
});

describe("custom fields: a project-limited key sees org-wide fields and its projects'", () => {
  it("narrows to projectId null or P1", async () => {
    h.getAuthContext.mockResolvedValue(key());
    expect((await get(listCustomFields)).status).toBe(200);
    expect(where(h.fields)).toEqual({ orgId: ORG, OR: [{ projectId: null }, { projectId: { in: [P1] } }] });
  });

  it("a session sees the org's fields, as before", async () => {
    h.getAuthContext.mockResolvedValue(session());
    await get(listCustomFields);
    expect(where(h.fields)).toEqual({ orgId: ORG });
  });
});
