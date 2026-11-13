// @vitest-environment node
//
// RBAC + secret-hygiene lock for the API-key mint/list routes
// (POST/GET .../api-keys). Mock ONLY the I/O boundaries (session, prisma,
// mintApiKey, audit) and assert:
//   - POST by someone who may hold keys → 201, the response carries the
//     one-time `token`, and the key is written inside the cap's transaction.
//   - POST by an API key → 403, whatever the key's creator could do.
//   - POST without API_KEY_CREATE or API_KEY_MANAGE → 403, mintApiKey NOT called.
//   - GET projection never includes `keyHash` or an email, and is limited to
//     the caller's own keys unless they hold API_KEY_MANAGE.
// The behaviour against a real database is in member-keys.db.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
const { getAuthContext, getCurrentUser, prisma, tx, mintApiKey, logAudit, loadEffectivePermissions } = vi.hoisted(() => {
  // The cap reads the creator's unexpired keys inside the transaction.
  const tx = { $queryRaw: vi.fn(), apiKey: { findMany: vi.fn() } };
  return {
    getAuthContext: vi.fn(),
    // The minting session: its IdP connection is recorded on the key.
    getCurrentUser: vi.fn(),
    tx,
    prisma: {
      organization: { findUnique: vi.fn() },
      orgSecuritySettings: { findUnique: vi.fn() },
      // The org's IdP connection: whether it requires single sign-on.
      idpConnection: { findUnique: vi.fn() },
      apiKey: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    mintApiKey: vi.fn(),
    logAudit: vi.fn(),
    // The list reads each creator's permissions to say when their keys stop.
    loadEffectivePermissions: vi.fn(),
  };
});

vi.mock("@/lib/auth/session", () => ({ getAuthContext, getCurrentUser }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));
vi.mock("@/lib/auth/api-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/api-key")>();
  return { ...actual, mintApiKey };
});

import { GET, POST } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const KEY_ID = "55555555-5555-5555-5555-555555555555";
const CONN_ID = "66666666-6666-6666-6666-666666666666";
const ssoRequired = { id: CONN_ID, enabled: true, enforced: true, org: { tenantClass: "GOV" } };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function ctxWith(permissions: bigint, extra: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
    ...extra,
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/api-keys`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function getRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/api-keys`, {
    method: "GET",
  });
}

const params = Promise.resolve({ orgId: ORG_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.orgSecuritySettings.findUnique.mockResolvedValue(null); // the default: member keys on
  loadEffectivePermissions.mockResolvedValue({ permissions: RolePermissions.MEMBER });
  prisma.idpConnection.findUnique.mockResolvedValue(null); // the default: no single sign-on required
  getCurrentUser.mockResolvedValue({ id: ACTOR_ID, idpConnId: null });
  tx.apiKey.findMany.mockResolvedValue([]);
  mintApiKey.mockResolvedValue({
    token: "cosmos_abc123_secretsecretsecret",
    record: {
      id: KEY_ID,
      name: "CI bot",
      prefix: "abc123",
      scopes: ["read"],
      projectIds: [],
      expiresAt: new Date(inDays(30)),
      createdAt: new Date(),
    },
  });
});

describe("POST /api-keys — mint", () => {
  it("a member → 201, the response includes the token, and the key is written in the cap's transaction", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.MEMBER));

    const res = await POST(postRequest({ name: "CI bot", scopes: ["read"], expiresAt: inDays(30) }), { params });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.token).toBe("cosmos_abc123_secretsecretsecret");
    expect(mintApiKey).toHaveBeenCalledTimes(1);
    expect(mintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, name: "CI bot", scopes: ["read"], createdById: ACTOR_ID, idpConnId: null }),
      tx,
    );
    // Judged as a key is: the creator's permissions with no owner break-glass.
    expect(loadEffectivePermissions).toHaveBeenCalledWith(ORG_ID, ACTOR_ID, { forApiKey: true });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1); // the row lock
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "api_key.created", entityId: KEY_ID }));
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain("secretsecretsecret");
  });

  it("an API key → 403 even when its creator is an owner, and mintApiKey is never called", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.OWNER, { isApiKey: true, scopes: ["read"] }));

    const res = await POST(postRequest({ name: "CI bot", scopes: ["read"], expiresAt: inDays(30) }), { params });

    expect(res.status).toBe(403);
    expect((await res.json()).detail).toMatch(/API key can't create/);
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it("without API_KEY_CREATE or API_KEY_MANAGE → 403 and mintApiKey is never called", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.GUEST));
    loadEffectivePermissions.mockResolvedValue({ permissions: RolePermissions.GUEST });

    const res = await POST(postRequest({ name: "CI bot", scopes: ["read"], expiresAt: inDays(30) }), { params });

    expect(res.status).toBe(403);
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it("with member keys turned off, a member → 403; the policy is read once", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.MEMBER));
    prisma.orgSecuritySettings.findUnique.mockResolvedValue({ memberApiKeysEnabled: false });

    const res = await POST(postRequest({ name: "CI bot", scopes: ["read"], expiresAt: inDays(30) }), { params });

    expect(res.status).toBe(403);
    expect(prisma.orgSecuritySettings.findUnique).toHaveBeenCalledTimes(1);
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it("at the cap → 409, nothing written", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.MEMBER));
    tx.apiKey.findMany.mockResolvedValue(Array.from({ length: 20 }, () => ({ createdAt: new Date(), expiresAt: null })));

    const res = await POST(postRequest({ name: "CI bot", scopes: ["read"], expiresAt: inDays(30) }), { params });

    expect(res.status).toBe(409);
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it("where the org requires single sign-on, a member mints only from a session of its IdP, and the key records it", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.MEMBER));
    prisma.idpConnection.findUnique.mockResolvedValue(ssoRequired);

    const refused = await POST(postRequest({ name: "CI bot", scopes: ["read"], expiresAt: inDays(30) }), { params });
    expect(refused.status).toBe(403);
    expect((await refused.json()).detail).toMatch(/requires single sign-on/);
    expect(mintApiKey).not.toHaveBeenCalled();

    getCurrentUser.mockResolvedValue({ id: ACTOR_ID, idpConnId: CONN_ID });
    const res = await POST(postRequest({ name: "CI bot", scopes: ["read"], expiresAt: inDays(30) }), { params });
    expect(res.status).toBe(201);
    expect(mintApiKey).toHaveBeenCalledWith(expect.objectContaining({ idpConnId: CONN_ID }), tx);
  });

  it("an admin mints without single sign-on, as before: the requirement isn't read for them", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.ADMIN));
    loadEffectivePermissions.mockResolvedValue({ permissions: RolePermissions.ADMIN });
    prisma.idpConnection.findUnique.mockResolvedValue(ssoRequired);

    const res = await POST(postRequest({ name: "CI bot", scopes: ["read"], expiresAt: inDays(30) }), { params });
    expect(res.status).toBe(201);
    expect(prisma.idpConnection.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api-keys — list", () => {
  const row = {
    id: KEY_ID,
    name: "CI bot",
    prefix: "abc123",
    scopes: ["read"],
    projectIds: [],
    expiresAt: null,
    lastUsed: null,
    createdAt: new Date(),
    createdBy: { id: ACTOR_ID, displayName: "Ada" },
  };

  it("never selects keyHash or an email, and names the creator by id and name", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.ADMIN));
    prisma.apiKey.findMany.mockResolvedValue([row]);

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    const { select, where } = prisma.apiKey.findMany.mock.calls[0][0];
    expect(select.keyHash).toBeUndefined();
    expect(select.createdBy).toEqual({ select: { id: true, displayName: true } });
    expect(where).toEqual({ orgId: ORG_ID }); // an admin sees every key

    const json = await res.json();
    expect(json[0].createdBy).toEqual({ id: ACTOR_ID, name: "Ada" });
    expect(JSON.stringify(json)).not.toContain("keyHash");
  });

  it("someone without API_KEY_MANAGE lists only their own keys", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.MEMBER));
    prisma.apiKey.findMany.mockResolvedValue([row]);

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    expect(prisma.apiKey.findMany.mock.calls[0][0].where).toEqual({ orgId: ORG_ID, createdById: ACTOR_ID });
  });

  it("says when each key really stops: never for a manager's key, 366 days on once its creator can't manage keys", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.ADMIN));
    const createdAt = new Date("2026-03-01T10:00:00Z");
    prisma.apiKey.findMany.mockResolvedValue([{ ...row, createdAt, expiresAt: null }]);

    loadEffectivePermissions.mockResolvedValue({ permissions: RolePermissions.ADMIN });
    const managed = await (await GET(getRequest(), { params })).json();
    expect(managed[0].effectiveExpiresAt).toBeNull();
    expect(loadEffectivePermissions).toHaveBeenCalledWith(ORG_ID, ACTOR_ID, { forApiKey: true });

    loadEffectivePermissions.mockResolvedValue({ permissions: RolePermissions.MEMBER });
    const capped = await (await GET(getRequest(), { params })).json();
    expect(capped[0].expiresAt).toBeNull(); // what was set stays as it was
    expect(capped[0].effectiveExpiresAt).toBe("2027-03-02T23:59:59.999Z");
  });

  it("says when a key works for nobody, and why, from the verifier's own rule", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.ADMIN));
    prisma.apiKey.findMany.mockResolvedValue([{ ...row, createdAt: new Date(), expiresAt: new Date(inDays(30)), idpConnId: null }]);
    const reason = async () => (await (await GET(getRequest(), { params })).json())[0].inactiveReason;

    loadEffectivePermissions.mockResolvedValue({ permissions: RolePermissions.MEMBER });
    expect(await reason()).toBeNull(); // positive control: a member's fresh key works
    loadEffectivePermissions.mockResolvedValue({ permissions: RolePermissions.GUEST });
    expect(await reason()).toBe("role");
    loadEffectivePermissions.mockResolvedValue(null);
    expect(await reason()).toBe("creator_gone");
    loadEffectivePermissions.mockResolvedValue({ permissions: RolePermissions.MEMBER });
    prisma.orgSecuritySettings.findUnique.mockResolvedValue({ memberApiKeysEnabled: false });
    expect(await reason()).toBe("switch_off");
    prisma.orgSecuritySettings.findUnique.mockResolvedValue(null);
    prisma.idpConnection.findUnique.mockResolvedValue(ssoRequired);
    expect(await reason()).toBe("sso");
    // The IdP the key was made through is never sent to the page.
    expect(JSON.stringify(await (await GET(getRequest(), { params })).json())).not.toContain("idpConnId");
  });

  it("an API key → 403", async () => {
    getAuthContext.mockResolvedValue(ctxWith(RolePermissions.OWNER, { isApiKey: true, scopes: ["read"] }));
    const res = await GET(getRequest(), { params });
    expect(res.status).toBe(403);
    expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
  });
});
