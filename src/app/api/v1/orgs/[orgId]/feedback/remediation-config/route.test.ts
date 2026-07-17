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

const { publishToOrg } = vi.hoisted(() => ({ publishToOrg: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/ai/ai-credentials", () => ({ getAiProviderStatus }));
// Realtime publish is a best-effort side-effect (COSMOS-130); mock it so we can
// assert a settings.updated event fires on a valid save (and never on a reject).
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg }));

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
  autonomousDelivery: { enabled: false, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 },
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
    // A rejected save must NOT emit a live-update event.
    expect(publishToOrg).not.toHaveBeenCalled();
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

    // A valid save publishes settings.updated (org-scoped) so open settings
    // views in another tab refresh live (COSMOS-130).
    expect(publishToOrg).toHaveBeenCalledWith(
      ORG_ID,
      "settings.updated",
      expect.objectContaining({ orgId: ORG_ID, section: "automation" }),
    );

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

  it("persists the picker's Parallel-builds count (autonomousDelivery.workers = N) — non-default value round-trips", async () => {
    // COSMOS-110: the picker sends workers=N in the PUT body; the route must
    // persist exactly that into Organization.settings (not silently fall back to
    // the zod default). Using a NON-default value (3) is deliberate — a value of
    // 2 would be masked by `workers: z.number()...default(2)` even if the route
    // dropped the field, so it couldn't catch the reported "no workers key /
    // wrong worker cap" regression. 3 can only come from the body.
    const body = {
      autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
      autonomousDelivery: { enabled: true, projectIds: [PROJECT_A], notify: { parked: true, shipped: true }, workers: 3 },
    };
    const putRes = await PUT(put(body), { params });
    expect(putRes.status).toBe(200);
    expect((await putRes.json()).autonomousDelivery.workers).toBe(3);

    // Landed in the stored settings blob…
    const stored = prisma.organization.update.mock.calls[0][0].data.settings as {
      autonomousDelivery: { workers: number };
    };
    expect(stored.autonomousDelivery.workers).toBe(3);

    // …and a subsequent GET reads it back as 3 (visible in org settings — AC #1).
    const getRes = await GET(get(), { params });
    expect((await getRes.json()).autonomousDelivery.workers).toBe(3);
  });

  it("normalizes a legacy autonomousDelivery body with no workers key to the safe default (2) on GET", async () => {
    // The exact shape observed in the wild: enabled + projectIds, no `workers`.
    // GET must surface a finite in-range default (2) rather than undefined/NaN,
    // so the picker + the daemon's worker target never read a broken value.
    orgSettings = { autonomousDelivery: { enabled: true, projectIds: [PROJECT_A] } };
    const res = await GET(get(), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).autonomousDelivery.workers).toBe(2);
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

describe("remediation-config — intake policy (Phase 3c)", () => {
  it("GET returns the safe default policy when nothing is configured", async () => {
    const res = await GET(get(), { params });
    const body = await res.json();
    expect(body.intakePolicy).toEqual({
      rateLimits: { perUserPerRun: 10, perOrgPerRun: 50, maxQueueDepth: 100, buildBudget: 100 },
      autoTriggerRoles: ["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER"],
      classifier: { judgeMinConfidence: "medium" },
      highRiskZones: ["auth", "secrets", "billing", "data-destructive", "security-egress", "dependencies"],
    });
  });

  it("PUT persists a policy (normalized) and a GET round-trips it", async () => {
    const body = {
      ...VALID_BODY,
      intakePolicy: {
        rateLimits: { perUserPerRun: 3, perOrgPerRun: 20, maxQueueDepth: 40, buildBudget: 25 },
        // Deliberately out of canonical order + a bogus role to prove normalization.
        autoTriggerRoles: ["ADMIN", "OWNER", "NOT_A_ROLE"],
        classifier: { judgeMinConfidence: "high" },
        highRiskZones: ["billing", "auth", "made-up-zone"],
      },
    };
    const putRes = await PUT(put(body), { params });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.intakePolicy.autoTriggerRoles).toEqual(["OWNER", "ADMIN"]);
    expect(putBody.intakePolicy.classifier).toEqual({ judgeMinConfidence: "high" });
    expect(putBody.intakePolicy.highRiskZones).toEqual(["auth", "billing"]);

    // Persisted under the same keys the remediation loop reads (so it takes effect).
    const stored = prisma.organization.update.mock.calls[0][0].data.settings as Record<string, unknown>;
    expect(stored.classifierPolicy).toEqual({ judgeMinConfidence: "high" });
    expect(stored.intakeLimits).toEqual({ perUserPerRun: 3, perOrgPerRun: 20, maxQueueDepth: 40, buildBudget: 25 });
    expect(stored.autoTriggerRoles).toEqual(["OWNER", "ADMIN"]);
    expect(stored.highRiskZones).toEqual(["auth", "billing"]);
    // Untouched pre-existing keys survive.
    expect(stored.unrelatedKey).toEqual({ keep: "me" });

    const getRes = await GET(get(), { params });
    const getBody = await getRes.json();
    expect(getBody.intakePolicy.autoTriggerRoles).toEqual(["OWNER", "ADMIN"]);
    expect(getBody.intakePolicy.rateLimits.perUserPerRun).toBe(3);
    expect(getBody.intakePolicy.highRiskZones).toEqual(["auth", "billing"]);
  });

  it("a PUT WITHOUT intakePolicy (e.g. console pause/resume) leaves an existing policy untouched", async () => {
    orgSettings = {
      ...orgSettings,
      classifierPolicy: { judgeMinConfidence: "low" },
      autoTriggerRoles: ["OWNER"],
    };
    const putRes = await PUT(put(VALID_BODY), { params });
    expect(putRes.status).toBe(200);
    const getRes = await GET(get(), { params });
    const body = await getRes.json();
    expect(body.intakePolicy.classifier).toEqual({ judgeMinConfidence: "low" });
    expect(body.intakePolicy.autoTriggerRoles).toEqual(["OWNER"]);
  });
});
