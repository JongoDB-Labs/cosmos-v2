// @vitest-environment node
//
// POST /projects under an org numbering standard: a project created without a
// number takes the next one, a chosen number is checked, a race on the unique
// index takes the following number, and the naming pattern shapes the name.
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
const ctx: AuthContext = {
  userId: "44444444-4444-4444-8444-444444444444",
  orgId: ORG_ID,
  orgRole: OrgRole.ADMIN,
  permissions: RolePermissions.ADMIN,
  basePermissions: RolePermissions.ADMIN,
  abacRules: [],
};
const THIS_YEAR = String(new Date().getUTCFullYear() % 100).padStart(2, "0");

function settings(numbering: Record<string, unknown> | null) {
  prisma.organization.findUnique.mockResolvedValue({
    id: ORG_ID,
    slug: "acme",
    settings: numbering ? { projects: { numbering } } : {},
  });
}

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/projects`, {
      method: "POST",
      body: JSON.stringify({ name: "Riverside Library", key: "RIVER", ...body }),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ orgId: ORG_ID }) },
  );

const created = () => tx.project.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(ctx);
  prisma.project.findUnique.mockResolvedValue(null); // key free
  prisma.project.findFirst.mockResolvedValue(null); // number free
  prisma.project.findMany.mockResolvedValue([]);
  tx.board.create.mockResolvedValue({ id: "b1" });
  tx.orgMember.findUnique.mockResolvedValue(null);
  tx.project.create.mockImplementation(async ({ data }) => ({ id: PROJECT_ID, ...data }));
  tx.project.findUnique.mockImplementation(async () =>
    projectRow({ id: PROJECT_ID, orgId: ORG_ID, ...created().at(-1), boards: [] }),
  );
});

describe("POST /projects — numbering", () => {
  it("no standard: unnumbered, name as typed (today's behaviour)", async () => {
    settings(null);
    const res = await post({});
    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({ number: null, name: "Riverside Library" });
  });

  it("takes the next number in this year's sequence", async () => {
    settings({ pattern: "YY-NNN" });
    prisma.project.findMany.mockResolvedValue([{ number: `${THIS_YEAR}-001` }, { number: `${THIS_YEAR}-002` }]);
    const res = await post({});
    expect(res.status).toBe(201);
    expect(created()[0].number).toBe(`${THIS_YEAR}-003`);
    expect((await res.json()).number).toBe(`${THIS_YEAR}-003`);
  });

  it("applies the naming pattern", async () => {
    settings({ pattern: "YY-NNN", namePattern: "{number} {name}" });
    await post({});
    expect(created()[0].name).toBe(`${THIS_YEAR}-001 Riverside Library`);
  });

  it("keeps a number the caller chose", async () => {
    settings({ pattern: "YY-NNN" });
    await post({ number: "LEGACY-17" });
    expect(created()[0].number).toBe("LEGACY-17");
  });

  it("a chosen number that's taken is a 409, and nothing is created", async () => {
    settings({ pattern: "YY-NNN" });
    prisma.project.findFirst.mockResolvedValue({ id: "other" });
    const res = await post({ number: `${THIS_YEAR}-001` });
    expect(res.status).toBe(409);
    expect(tx.project.create).not.toHaveBeenCalled();
  });

  it("losing a race for an allocated number takes the next one", async () => {
    settings({ pattern: "YY-NNN" });
    // The first allocation sees nothing; by the retry, the racer's project exists.
    prisma.project.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ number: `${THIS_YEAR}-001` }]);
    tx.project.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002", meta: { target: ["org_id", "number"] } });
    });
    const res = await post({});
    expect(res.status).toBe(201);
    expect(created().map((d) => d.number)).toEqual([`${THIS_YEAR}-001`, `${THIS_YEAR}-002`]);
  });

  it("a different unique violation is not retried as a numbering race", async () => {
    settings({ pattern: "YY-NNN" });
    tx.project.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002", meta: { target: ["org_id", "key"] } });
    });
    await post({});
    expect(tx.project.create).toHaveBeenCalledTimes(1);
  });
});
