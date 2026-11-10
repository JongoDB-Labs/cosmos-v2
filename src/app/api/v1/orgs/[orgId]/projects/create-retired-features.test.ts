// @vitest-environment node
//
// POST /projects from a template: a template's enabledFeatures are copied onto
// the new project, EXCEPT retired ones. The built-in template rows were written
// by migrations with the PM suite in them, and seeds only run at bootstrap, so
// filtering the seeds alone left every existing deployment still handing the
// retired modules to each new project.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";
import { projectRow } from "@/lib/openapi/testing/rows";

const { getAuthContext, prisma, tx } = vi.hoisted(() => {
  const tx = {
    project: { create: vi.fn(), findUnique: vi.fn() },
    board: { create: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { create: vi.fn() },
  };
  return {
    tx,
    getAuthContext: vi.fn(),
    prisma: {
      organization: { findUnique: vi.fn() },
      project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
      projectTemplate: { findUnique: vi.fn() },
      orgEntitlements: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/cache/queries", () => ({ revalidateOrgProjects: vi.fn() }));
vi.mock("@/lib/workflow/provision.server", () => ({ seedBoardColumns: vi.fn() }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
const ctx: AuthContext = {
  userId: "44444444-4444-4444-8444-444444444444",
  orgId: ORG_ID,
  orgRole: OrgRole.ADMIN,
  permissions: RolePermissions.ADMIN,
  basePermissions: RolePermissions.ADMIN,
  abacRules: [],
};

const created = () => tx.project.create.mock.calls.map((c) => c[0].data);

function template(enabledFeatures: string[]) {
  prisma.projectTemplate.findUnique.mockResolvedValue({
    id: TEMPLATE_ID,
    orgId: null,
    isBuiltIn: true,
    sector: "software",
    defaultConfig: { enabledFeatures },
    boardTemplates: [],
  });
}

const post = () =>
  POST(
    new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/projects`, {
      method: "POST",
      body: JSON.stringify({ name: "Riverside Library", key: "RIVER", templateId: TEMPLATE_ID }),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ orgId: ORG_ID }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(ctx);
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", settings: {} });
  prisma.orgEntitlements.findUnique.mockResolvedValue(null); // all sectors enabled
  prisma.project.findUnique.mockResolvedValue(null);
  prisma.project.findFirst.mockResolvedValue(null);
  prisma.project.findMany.mockResolvedValue([]);
  tx.orgMember.findUnique.mockResolvedValue(null);
  tx.project.create.mockImplementation(async ({ data }) => ({ id: PROJECT_ID, ...data }));
  tx.project.findUnique.mockImplementation(async () =>
    projectRow({ id: PROJECT_ID, orgId: ORG_ID, ...created().at(-1), boards: [] }),
  );
});

describe("POST /projects — features from a template", () => {
  it("copies the template's live features (control)", async () => {
    template(["roadmap", "okrs"]);
    expect((await post()).status).toBe(201);
    expect(created()[0].enabledFeatures).toEqual(["roadmap", "okrs"]);
  });

  it("drops retired features a template still lists, keeping the rest in order", async () => {
    // What the built-in Software template holds on every deployment migrated
    // before the Program Management page.
    template(["roadmap", "pm-dashboard", "risk-register", "okrs", "program-calendar"]);
    expect((await post()).status).toBe(201);
    expect(created()[0].enabledFeatures).toEqual(["roadmap", "okrs"]);
  });
});
