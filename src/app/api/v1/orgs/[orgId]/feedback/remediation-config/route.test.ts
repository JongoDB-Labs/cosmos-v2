// @vitest-environment node
//
// RBAC + multi-project schema for the TENANT-ADMIN feedback remediation-config
// route. Proves:
//   - RBAC: 401 with no auth context, 403 without ORG_UPDATE;
//   - the enable gate (real @/lib/feedback/automation-config, UNMOCKED) rejects
//     enabling auto-triage with an empty project scope — 400, no DB write;
//   - a projectId that isn't a live project in THIS org is rejected 400,
//     whether it shows up in projectIds, autonomousDelivery.projectIds, or
//     defaultProjectId — no DB write;
//   - a valid PUT merges into Organization.settings (without clobbering other
//     keys) and a subsequent GET round-trips the normalized shape + never
//     leaks OrgMember.permissions.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, getAiProviderStatus } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
    project: { findMany: vi.fn() },
  },
  getAiProviderStatus: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/ai/ai-credentials", () => ({ getAiProviderStatus }));

import { GET, PUT } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSIDE_ORG_PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const params = Promise.resolve({ orgId: ORG_ID });

function ctx(perms: bigint): AuthContext {
  return {
    userId: "44444444-4444-4444-4444-444444444444",
    orgId: ORG_ID, orgRole: OrgRole.ADMIN,
    permissions: perms, basePermissions: perms, abacRules: [],
  };
}
function get() {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/feedback/remediation-config`);
}
function put(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/feedback/remediation-config`, {
    method: "PUT", body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  autoRemediation: { enabled: true, projectIds: [PROJECT_A], defaultProjectId: PROJECT_A },
  autonomousDelivery: { enabled: false, projectIds: [], notify: { parked: true, shipped: true } },
};

// Stateful settings store behind the mocked organization row, so a PUT
// followed by a GET in the same test proves the route round-trips through
// Organization.settings rather than just asserting the upsert call shape.
let orgSettings: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  orgSettings = { unrelatedKey: { keep: "me" } };
  prisma.organization.findUnique.mockImplementation(async () => ({
    slug: "acme",
    settings: orgSettings,
  }));
  prisma.organization.update.mockImplementation(async ({ data }: { data: { settings: Record<string, unknown> } }) => {
    orgSettings = data.settings;
    return { id: ORG_ID };
  });
  prisma.project.findMany.mockResolvedValue([
    { id: PROJECT_A, key: "AAA", name: "Project A" },
    { id: PROJECT_B, key: "BBB", name: "Project B" },
  ]);
  getAiProviderStatus.mockResolvedValue({
    provider: "anthropic",
    anthropic: { configured: false },
    openai: { configured: false },
    claudeOAuth: { connected: false },
  });
  getAuthContext.mockResolvedValue(ctx(Permission.ORG_UPDATE));
});

describe("remediation-config — RBAC", () => {
  it("401 when there's no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await PUT(put(VALID_BODY), { params });
    expect(res.status).toBe(401);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("403 for a caller WITHOUT ORG_UPDATE", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    const res = await PUT(put(VALID_BODY), { params });
    expect(res.status).toBe(403);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("403 on GET WITHOUT ORG_UPDATE", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    const res = await GET(get(), { params });
    expect(res.status).toBe(403);
  });
});

describe("remediation-config — PUT enable gate", () => {
  it("400 with the gate reason when enabling auto-triage with an empty project scope", async () => {
    const res = await PUT(
      put({
        autoRemediation: { enabled: true, projectIds: [], defaultProjectId: null },
        autonomousDelivery: { enabled: false, projectIds: [] },
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Select at least one project to receive triaged feedback before enabling auto-triage.",
    });
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("400 with the gate reason when the default project isn't one of the selected projects", async () => {
    const res = await PUT(
      put({
        autoRemediation: { enabled: true, projectIds: [PROJECT_A], defaultProjectId: PROJECT_B },
        autonomousDelivery: { enabled: false, projectIds: [] },
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("400 with the gate reason when enabling autonomous delivery with an empty project scope", async () => {
    const res = await PUT(
      put({
        autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
        autonomousDelivery: { enabled: true, projectIds: [] },
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });
});

describe("remediation-config — PUT org-scoping", () => {
  it("400 when a projectId in autoRemediation.projectIds isn't in this org", async () => {
    const res = await PUT(
      put({
        autoRemediation: { enabled: false, projectIds: [OUTSIDE_ORG_PROJECT], defaultProjectId: null },
        autonomousDelivery: { enabled: false, projectIds: [] },
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not found/i) });
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("400 when a projectId in autonomousDelivery.projectIds isn't in this org", async () => {
    const res = await PUT(
      put({
        autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
        autonomousDelivery: { enabled: true, projectIds: [OUTSIDE_ORG_PROJECT] },
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("400 when defaultProjectId isn't in this org (even if it is in projectIds)", async () => {
    const res = await PUT(
      put({
        autoRemediation: {
          enabled: true,
          projectIds: [PROJECT_A, OUTSIDE_ORG_PROJECT],
          defaultProjectId: OUTSIDE_ORG_PROJECT,
        },
        autonomousDelivery: { enabled: false, projectIds: [] },
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("400 on an archived project id (findMany is scoped to archived:false)", async () => {
    // The mocked project.findMany only ever returns the two live projects, so
    // any id outside that set (including a since-archived one) is rejected —
    // proving the route can't be used to triage into an archived project.
    const res = await PUT(
      put({
        autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
        autonomousDelivery: { enabled: false, projectIds: [OUTSIDE_ORG_PROJECT] },
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: ORG_ID, archived: false }) }),
    );
  });

  it("rejects invalid input (non-uuid projectId) with 400 via zod, no DB write", async () => {
    const res = await PUT(
      put({
        autoRemediation: { enabled: false, projectIds: ["not-a-uuid"], defaultProjectId: null },
        autonomousDelivery: { enabled: false, projectIds: [] },
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });
});

describe("remediation-config — valid PUT persists, GET round-trips", () => {
  it("merges autoRemediation + autonomousDelivery into settings without clobbering other keys", async () => {
    const putRes = await PUT(put(VALID_BODY), { params });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toMatchObject(VALID_BODY);

    const updateArg = prisma.organization.update.mock.calls[0][0];
    expect(updateArg.data.settings).toEqual({
      unrelatedKey: { keep: "me" }, // untouched
      autoRemediation: VALID_BODY.autoRemediation,
      autonomousDelivery: VALID_BODY.autonomousDelivery,
    });

    const getRes = await GET(get(), { params });
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.autoRemediation).toEqual(VALID_BODY.autoRemediation);
    expect(body.autonomousDelivery).toEqual(VALID_BODY.autonomousDelivery);
    expect(body.projects).toEqual([
      { id: PROJECT_A, key: "AAA", name: "Project A" },
      { id: PROJECT_B, key: "BBB", name: "Project B" },
    ]);
    expect(body.aiConnected).toBe(false);
    expect(body.aiProvider).toBe("anthropic");
    expect(body.claudeSubscription).toEqual({ connected: false });
    expect(JSON.stringify(body)).not.toContain("permissions");
  });

  it("GET normalizes a legacy single-project settings shape (back-compat via automation-config)", async () => {
    orgSettings = { autoRemediation: { enabled: true, targetProjectId: PROJECT_A } };
    const res = await GET(get(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.autoRemediation).toEqual({
      enabled: true,
      projectIds: [PROJECT_A],
      defaultProjectId: PROJECT_A,
    });
  });
});
