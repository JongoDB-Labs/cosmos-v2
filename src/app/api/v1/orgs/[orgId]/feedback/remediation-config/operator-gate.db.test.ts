// @vitest-environment node
//
// Turning on automated delivery or auto-triage, adding a project to either, or
// raising the parallel build workers puts more of an organization's work into
// the deployment's shared build pool, which runs on the instance operator's
// host. That is the operator's call, not an org admin's. Turning things off,
// removing projects, fewer workers, and the notify and intake-policy settings
// stay with ORG_UPDATE.
//
// Real database, the real requireSystemAdmin (INTERNAL_ADMINS + the session
// user) and the real stored-config comparison. Only the request's identity is
// crafted: `getAuthContext` returns the actor, `getCurrentUser` stands in for
// the session cookie.
//
// Every refusal asserts the operator sentence, not just a 403: each crafted
// actor holds ORG_UPDATE, so a 403 from the permission check would otherwise
// pass these tests without the gate existing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown, cookieUser: null as unknown, failAudit: false }));
vi.mock("@/lib/auth/session", () => ({
  getAuthContext: async () => h.ctx,
  getCurrentUser: async () => h.cookieUser,
}));
// The real audit writer, unless a test makes the audit store fail.
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    logAudit: async (...args: Parameters<typeof actual.logAudit>) => {
      if (h.failAudit) throw new Error("audit store unavailable");
      return actual.logAudit(...args);
    },
  };
});
// Side effects of a save that are not under test here.
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: () => {} }));
vi.mock("@/lib/cache/queries", () => ({ revalidateOrg: () => {} }));

import { GET, PUT } from "./route";
import { PUT as putOrg } from "@/app/api/v1/orgs/[orgId]/route";

const OPERATOR_ONLY = "Only the instance operator can turn on automated delivery or add build workers.";
const AUDIT_ACTION = "feedback_automation.changed";
const REFUSED_ACTION = "feedback_automation.refused";

const stamp = Math.random().toString(36).slice(2, 8);
const operatorEmail = `op-${stamp}@delivery-gate.test`;
const ownerEmail = `owner-${stamp}@delivery-gate.test`;

let orgId = "";
let operatorId = "";
let ownerId = "";
let projectA = "";
let projectB = "";

const at = () => ({ params: Promise.resolve({ orgId }) });
const configUrl = () => `http://localhost/api/v1/orgs/${orgId}/feedback/remediation-config`;
const putConfig = (body: unknown) => PUT(new NextRequest(configUrl(), { method: "PUT", body: JSON.stringify(body) }), at());
const getConfig = () => GET(new NextRequest(configUrl()), at());

// A Google session through the account's bound Google identity: the kind the
// trusted system-admin rule (lib/internal/access isSystemAdmin) counts.
function sessionOf(userId: string, email: string, trust: Record<string, unknown> = {}) {
  return {
    id: userId,
    email,
    displayName: email,
    avatarUrl: null,
    authMethod: "google",
    idpConnId: null,
    ssoProvisioned: false,
    googleBound: true,
    microsoftBound: false,
    passwordUntrusted: false,
    amr: [],
    mfaSatisfied: false,
    sessionId: `s-${userId}`,
    lastActivityAt: new Date(),
    ...trust,
  };
}
function ownerCtx(userId: string, extra: Partial<AuthContext> = {}): AuthContext {
  return {
    userId,
    orgId,
    orgRole: "OWNER",
    permissions: RolePermissions.OWNER,
    basePermissions: RolePermissions.OWNER,
    abacRules: [],
    ...extra,
  };
}
const asOperator = () => {
  h.ctx = ownerCtx(operatorId);
  h.cookieUser = sessionOf(operatorId, operatorEmail);
};
const asOwner = () => {
  h.ctx = ownerCtx(ownerId);
  h.cookieUser = sessionOf(ownerId, ownerEmail);
};

const off = () => ({
  autoRemediation: { enabled: false, projectIds: [] as string[], defaultProjectId: null as string | null },
  autonomousDelivery: { enabled: false, projectIds: [] as string[], notify: { parked: true, shipped: true }, workers: 2 },
});
const deliveryOn = (projectIds: string[]) => ({
  ...off(),
  autonomousDelivery: { enabled: true, projectIds, notify: { parked: true, shipped: true }, workers: 2 },
});

async function storeSettings(settings: Record<string, unknown>) {
  await prisma.organization.update({ where: { id: orgId }, data: { settings: settings as object } });
}
async function storedSettings() {
  return (await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } })).settings;
}
// The audit store is append-only (rows can't be deleted), so each test reads
// only the rows written since it started.
let seenAuditIds = new Set<string>();
const rowsFor = async (action: string) =>
  (await prisma.auditLog.findMany({ where: { orgId, action }, orderBy: { seq: "asc" } })).filter(
    (row) => !seenAuditIds.has(row.id),
  );
const auditRows = () => rowsFor(AUDIT_ACTION);
const refusedRows = () => rowsFor(REFUSED_ACTION);

async function expectOperatorOnly(res: Response) {
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error?: string }).error).toBe(OPERATOR_ONLY);
}

beforeAll(async () => {
  vi.stubEnv("INTERNAL_ADMINS", operatorEmail);
  orgId = (await prisma.organization.create({ data: { name: `dg ${stamp}`, slug: `dg-${stamp}` } })).id;
  operatorId = (await prisma.user.create({ data: { email: operatorEmail, displayName: "Operator", googleId: `g-op-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, displayName: "Owner" } })).id;
  for (const userId of [operatorId, ownerId]) {
    await prisma.orgMember.create({ data: { orgId, userId, role: "OWNER", permissions: "0" } });
  }
  const key = stamp.slice(0, 3).toUpperCase();
  projectA = (await prisma.project.create({ data: { orgId, name: "Alpha", key: `DA${key}` } })).id;
  projectB = (await prisma.project.create({ data: { orgId, name: "Bravo", key: `DB${key}` } })).id;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [operatorId, ownerId] } } });
});

beforeEach(async () => {
  h.failAudit = false;
  await storeSettings({ unrelated: { keep: "me" } });
  seenAuditIds = new Set((await prisma.auditLog.findMany({ where: { orgId }, select: { id: true } })).map((r) => r.id));
});

describe("turning automated delivery on is the instance operator's call", () => {
  it("the operator turns autonomous delivery on: 200, stored, and audited with counts only", async () => {
    asOperator();
    const res = await putConfig(deliveryOn([projectA]));
    expect(res.status).toBe(200);

    const stored = (await storedSettings()) as Record<string, { enabled?: boolean; projectIds?: string[] }>;
    expect(stored.autonomousDelivery).toMatchObject({ enabled: true, projectIds: [projectA] });
    expect(stored.unrelated).toEqual({ keep: "me" });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(operatorId);
    expect(rows[0].metadata).toMatchObject({
      byOperator: true,
      deliveryEnabledBefore: false,
      deliveryEnabledAfter: true,
      deliveryProjectsBefore: 0,
      deliveryProjectsAfter: 1,
      autoTriageEnabledBefore: false,
      autoTriageEnabledAfter: false,
      autoTriageProjectsBefore: 0,
      autoTriageProjectsAfter: 0,
    });
    // Counts, never which projects.
    const meta = JSON.stringify(rows[0].metadata);
    expect(meta).not.toContain(projectA);
    expect(meta).not.toContain("Alpha");
  });

  it("an org owner who is not the operator cannot turn it on: 403, nothing stored, and the refusal is audited", async () => {
    asOwner();
    const before = await storedSettings();
    await expectOperatorOnly(await putConfig(deliveryOn([projectA])));
    expect(await storedSettings()).toEqual(before);
    expect(await auditRows()).toHaveLength(0);

    const refused = await refusedRows();
    expect(refused).toHaveLength(1);
    expect(refused[0].userId).toBe(ownerId);
    expect(refused[0].metadata).toMatchObject({
      turnsOnDelivery: true,
      turnsOnAutoTriage: false,
      deliveryProjectsAdded: 1,
      autoTriageProjectsAdded: 0,
      workersBefore: 2,
      workersAfter: 2,
    });
    // Counts, never which projects.
    expect(JSON.stringify(refused[0].metadata)).not.toContain(projectA);
  });

  it("an org owner who is not the operator cannot turn auto-triage on either", async () => {
    asOwner();
    const before = await storedSettings();
    await expectOperatorOnly(
      await putConfig({ ...off(), autoRemediation: { enabled: true, projectIds: [projectA], defaultProjectId: projectA } }),
    );
    expect(await storedSettings()).toEqual(before);
  });

  it("an owner cannot add a project to an already-enabled list", async () => {
    await storeSettings(deliveryOn([projectA]));
    asOwner();
    await expectOperatorOnly(await putConfig(deliveryOn([projectA, projectB])));
    expect(((await storedSettings()) as { autonomousDelivery: { projectIds: string[] } }).autonomousDelivery.projectIds).toEqual([
      projectA,
    ]);
    expect(await auditRows()).toHaveLength(0);
  });

  it("an owner cannot add a project to a list that is switched off, either", async () => {
    asOwner();
    await expectOperatorOnly(
      await putConfig({ ...off(), autonomousDelivery: { ...off().autonomousDelivery, projectIds: [projectA] } }),
    );
  });

  it("the owner turns delivery off: 200, stored, audited", async () => {
    await storeSettings(deliveryOn([projectA, projectB]));
    asOwner();
    const res = await putConfig({
      ...off(),
      autonomousDelivery: { ...off().autonomousDelivery, enabled: false, projectIds: [projectA, projectB] },
    });
    expect(res.status).toBe(200);
    expect(((await storedSettings()) as { autonomousDelivery: { enabled: boolean } }).autonomousDelivery.enabled).toBe(false);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(ownerId);
    expect(rows[0].metadata).toMatchObject({
      byOperator: false,
      deliveryEnabledBefore: true,
      deliveryEnabledAfter: false,
      deliveryProjectsBefore: 2,
      deliveryProjectsAfter: 2,
    });
  });

  it("the owner removes one project: 200, stored, audited", async () => {
    await storeSettings(deliveryOn([projectA, projectB]));
    asOwner();
    const res = await putConfig(deliveryOn([projectA]));
    expect(res.status).toBe(200);
    expect(((await storedSettings()) as { autonomousDelivery: { projectIds: string[] } }).autonomousDelivery.projectIds).toEqual([
      projectA,
    ]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ deliveryProjectsBefore: 2, deliveryProjectsAfter: 1, deliveryEnabledAfter: true });
  });

  it("the owner changes notify and the intake policy on an enabled config: 200, and no automation audit row", async () => {
    await storeSettings(deliveryOn([projectA]));
    asOwner();
    const res = await putConfig({
      ...off(),
      autonomousDelivery: { enabled: true, projectIds: [projectA], notify: { parked: false, shipped: true }, workers: 2 },
      intakePolicy: { rateLimits: { perUserPerRun: 4, perOrgPerRun: 20, maxQueueDepth: 40, buildBudget: 25 } },
    });
    expect(res.status).toBe(200);
    const stored = (await storedSettings()) as {
      autonomousDelivery: { enabled: boolean; notify: { parked: boolean }; workers: number };
      intakeLimits?: { perUserPerRun: number };
    };
    expect(stored.autonomousDelivery).toMatchObject({ enabled: true, notify: { parked: false }, workers: 2 });
    expect(stored.intakeLimits?.perUserPerRun).toBe(4);
    // No flag, project list or worker count moved, so there is nothing to audit.
    expect(await auditRows()).toHaveLength(0);
  });

  it("an owner cannot raise parallel build workers: 403, nothing stored, and the refusal is audited", async () => {
    await storeSettings(deliveryOn([projectA]));
    asOwner();
    const before = await storedSettings();
    await expectOperatorOnly(
      await putConfig({ ...off(), autonomousDelivery: { ...deliveryOn([projectA]).autonomousDelivery, workers: 3 } }),
    );
    expect(await storedSettings()).toEqual(before);
    const refused = await refusedRows();
    expect(refused).toHaveLength(1);
    expect(refused[0].metadata).toMatchObject({ workersBefore: 2, workersAfter: 3, turnsOnDelivery: false, deliveryProjectsAdded: 0 });
  });

  it("an owner can lower parallel build workers: 200, stored, audited", async () => {
    await storeSettings({ ...deliveryOn([projectA]), autonomousDelivery: { ...deliveryOn([projectA]).autonomousDelivery, workers: 3 } });
    asOwner();
    const res = await putConfig({ ...off(), autonomousDelivery: { ...deliveryOn([projectA]).autonomousDelivery, workers: 1 } });
    expect(res.status).toBe(200);
    expect(((await storedSettings()) as { autonomousDelivery: { workers: number } }).autonomousDelivery.workers).toBe(1);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ byOperator: false, workersBefore: 3, workersAfter: 1 });
  });

  it("the operator can raise parallel build workers", async () => {
    await storeSettings(deliveryOn([projectA]));
    asOperator();
    const res = await putConfig({ ...off(), autonomousDelivery: { ...deliveryOn([projectA]).autonomousDelivery, workers: 3 } });
    expect(res.status).toBe(200);
    expect(((await storedSettings()) as { autonomousDelivery: { workers: number } }).autonomousDelivery.workers).toBe(3);
  });

  it("an operator session belonging to someone else does not make an owner the operator", async () => {
    // The request acts as the owner; only the cookie lookup answers with the
    // operator. The operator check has to be about the actor, not the cookie.
    h.ctx = ownerCtx(ownerId);
    h.cookieUser = sessionOf(operatorId, operatorEmail);
    await expectOperatorOnly(await putConfig(deliveryOn([projectA])));
  });

  // The operator's address is not enough: the session has to vouch for it.
  it.each([
    ["an account an organization's IdP made", { ssoProvisioned: true }],
    ["a password session whose password an SSO session could have set", { authMethod: "password", googleBound: false, passwordUntrusted: true }],
    ["an SSO sign-in", { authMethod: "oidc", idpConnId: "conn-1", googleBound: false }],
    ["a Google sign-in to an account with no bound Google identity", { googleBound: false }],
    ["a session from before sessions recorded how they signed in", { authMethod: null }],
  ])("%s at the operator's address is not the operator", async (_name, trust) => {
    h.ctx = ownerCtx(operatorId);
    h.cookieUser = sessionOf(operatorId, operatorEmail, trust);
    const before = await storedSettings();
    await expectOperatorOnly(await putConfig(deliveryOn([projectA])));
    expect(await storedSettings()).toEqual(before);
    expect(((await (await getConfig()).json()) as { viewerIsOperator?: boolean }).viewerIsOperator).toBe(false);

    // Positive control: the same actor, with a session that vouches for the address.
    asOperator();
    expect((await putConfig(deliveryOn([projectA]))).status).toBe(200);
  });

  it("an API key cannot turn it on, even one the operator minted", async () => {
    // A key request carries no session cookie, so requireSystemAdmin finds no
    // one. The key holds ORG_UPDATE here so that the operator gate, not the
    // permission check, is what refuses it.
    h.ctx = ownerCtx(operatorId, { isApiKey: true, scopes: ["admin"] });
    h.cookieUser = null;
    const before = await storedSettings();
    await expectOperatorOnly(await putConfig(deliveryOn([projectA])));
    expect(await storedSettings()).toEqual(before);
  });

  it("an API key cannot turn it on even when the operator's session cookie rides along", async () => {
    h.ctx = ownerCtx(operatorId, { isApiKey: true, scopes: ["admin"] });
    h.cookieUser = sessionOf(operatorId, operatorEmail);
    await expectOperatorOnly(await putConfig(deliveryOn([projectA])));
  });

  it("an API key can still turn it off", async () => {
    await storeSettings(deliveryOn([projectA]));
    h.ctx = ownerCtx(ownerId, { isApiKey: true, scopes: ["admin"] });
    h.cookieUser = null;
    const res = await putConfig(off());
    expect(res.status).toBe(200);
    expect(((await storedSettings()) as { autonomousDelivery: { enabled: boolean } }).autonomousDelivery.enabled).toBe(false);
  });

  it("if the audit row can't be written, the change is not saved either", async () => {
    asOperator();
    h.failAudit = true;
    const res = await putConfig(deliveryOn([projectA]));
    expect(res.status).toBeGreaterThanOrEqual(500);
    h.failAudit = false;
    expect(((await storedSettings()) as { autonomousDelivery?: unknown }).autonomousDelivery).toBeUndefined();
  });

  it("an org that is already enabled stays enabled when its owner saves it unchanged", async () => {
    await storeSettings(deliveryOn([projectA]));
    asOwner();
    expect((await putConfig(deliveryOn([projectA]))).status).toBe(200);
    expect(((await storedSettings()) as { autonomousDelivery: { enabled: boolean } }).autonomousDelivery.enabled).toBe(true);
  });
});

describe("the settings form learns whether the viewer is the operator, as a boolean", () => {
  it("true for the operator, false for an owner, false for an API key", async () => {
    asOperator();
    expect(((await (await getConfig()).json()) as { viewerIsOperator?: boolean }).viewerIsOperator).toBe(true);

    asOwner();
    const ownerBody = (await (await getConfig()).json()) as Record<string, unknown>;
    expect(ownerBody.viewerIsOperator).toBe(false);
    // The allowlist itself never reaches the response.
    expect(JSON.stringify(ownerBody)).not.toContain(operatorEmail);

    h.ctx = ownerCtx(operatorId, { isApiKey: true, scopes: ["admin"] });
    h.cookieUser = sessionOf(operatorId, operatorEmail);
    expect(((await (await getConfig()).json()) as { viewerIsOperator?: boolean }).viewerIsOperator).toBe(false);
  });
});

describe("the general organization update does not write settings at all", () => {
  it("PUT /orgs/{id} with a settings object is refused, so it is no way around the gate", async () => {
    asOwner();
    const before = await storedSettings();
    const res = await putOrg(
      new NextRequest(`http://localhost/api/v1/orgs/${orgId}`, {
        method: "PUT",
        body: JSON.stringify({ settings: { autonomousDelivery: { enabled: true, projectIds: [projectA] } } }),
      }),
      at(),
    );
    expect(res.status).toBe(400);
    expect(await storedSettings()).toEqual(before);
  });
});

// The operator turns delivery off while an owner's stale form re-sends "on".
// The owner's request has to decide against the row as it is when it writes,
// so it sees OFF and is refused; deciding against an earlier read would find
// no widen and put ON back.
describe("a stale 'on' arriving while the operator turns delivery off", () => {
  it("is refused, and delivery stays off", async () => {
    await storeSettings(deliveryOn([projectA]));
    asOwner();
    let ownerRes: Promise<Response> | null = null;
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
        ownerRes = putConfig(deliveryOn([projectA]));
        // Long enough for the owner's request to reach its own read and wait.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await tx.organization.update({ where: { id: orgId }, data: { settings: off() as object } });
      },
      { timeout: 20_000 },
    );
    const res = await ownerRes!;
    await expectOperatorOnly(res);
    expect(((await storedSettings()) as { autonomousDelivery: { enabled: boolean } }).autonomousDelivery.enabled).toBe(false);
  }, 30_000);
});
