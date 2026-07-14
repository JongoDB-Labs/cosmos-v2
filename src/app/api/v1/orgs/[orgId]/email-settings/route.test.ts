// @vitest-environment node
//
// Per-org email-delivery settings route. Proves:
//   - GET returns { provider, fromAddress, enabled, configured } and NEVER the key
//     value (no apiKey field, no plaintext, no sealed blob in the response);
//   - PUT SEALS a supplied apiKey with the vault before storage (the stored value
//     round-trips back to plaintext via openSecret, and the plaintext never appears
//     in the persisted column as cleartext);
//   - PUT with an omitted/empty apiKey leaves the existing sealed value UNTOUCHED
//     (no apiKey key in the upsert payload);
//   - an invalid fromAddress is a 400;
//   - OWNER-gating: a non-owner ADMIN that DOES hold ORG_MANAGE_SETTINGS is 403.
//
// Mocks only the I/O boundaries (session, db); the RBAC primitives and the REAL
// vault (seal/open under a test SSO_VAULT_KEY) run for real.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    orgEmailSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { openSecret } from "@/lib/crypto/vault";
import { GET, PUT } from "./route";

const VAULT_KEY = crypto.randomBytes(32).toString("base64");
const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const params = Promise.resolve({ orgId: ORG_ID });

beforeAll(() => {
  process.env.SSO_VAULT_KEY = VAULT_KEY;
  delete process.env.SSO_VAULT_KEYS;
  delete process.env.SSO_VAULT_ACTIVE_KID;
});

afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: { permissions?: bigint; orgRole: OrgRole }): AuthContext {
  const perms = opts.permissions ?? bits("ORG_READ", "ORG_MANAGE_SETTINGS");
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

function req(method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/email-settings`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.orgEmailSettings.upsert.mockResolvedValue({});
});

describe("GET /orgs/[orgId]/email-settings — never leaks the key", () => {
  beforeEach(() => getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.OWNER })));

  it("returns provider/fromAddress/enabled/configured and NEVER the sealed key value", async () => {
    const { sealSecret } = await import("@/lib/crypto/vault");
    const sealed = sealSecret("re_super_secret");
    prisma.orgEmailSettings.findUnique.mockResolvedValue({
      provider: "resend",
      fromAddress: "Cosmos <invites@example.com>",
      enabled: true,
      apiKey: { sealed },
    });

    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toEqual({
      provider: "resend",
      fromAddress: "Cosmos <invites@example.com>",
      enabled: true,
      configured: true,
    });
    // Hard proof no key material is serialized to the client.
    expect(body).not.toHaveProperty("apiKey");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("re_super_secret");
    expect(serialized).not.toContain(sealed);
  });

  it("reports defaults + configured:false when no row exists yet", async () => {
    prisma.orgEmailSettings.findUnique.mockResolvedValue(null);

    const res = await GET(req("GET"), { params });
    expect(await res.json()).toEqual({
      provider: "resend",
      fromAddress: null,
      enabled: false,
      configured: false,
    });
  });
});

describe("PUT /orgs/[orgId]/email-settings — seals the key", () => {
  beforeEach(() => {
    getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.OWNER }));
    prisma.orgEmailSettings.findUnique.mockResolvedValue({
      provider: "resend",
      fromAddress: "Cosmos <invites@example.com>",
      enabled: true,
      apiKey: { sealed: "sealed-placeholder-for-readback" },
    });
  });

  it("SEALS a supplied apiKey (round-trips via openSecret) and stamps updatedById; never echoes the key", async () => {
    const res = await PUT(
      req("PUT", {
        apiKey: "re_new_secret",
        fromAddress: "Cosmos <invites@example.com>",
        enabled: true,
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(prisma.orgEmailSettings.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.orgEmailSettings.upsert.mock.calls[0][0] as {
      where: unknown;
      create: { orgId: string; apiKey?: { sealed: string }; fromAddress?: string | null; enabled?: boolean; updatedById: string };
      update: { apiKey?: { sealed: string }; fromAddress?: string | null; enabled?: boolean; updatedById: string };
    };

    // The persisted key is SEALED (not cleartext) and opens back to the plaintext.
    const sealed = arg.update.apiKey?.sealed;
    expect(typeof sealed).toBe("string");
    expect(sealed).not.toContain("re_new_secret");
    expect(openSecret(sealed as string)).toBe("re_new_secret");
    expect(arg.create.apiKey?.sealed).toBe(sealed);

    expect(arg.update.fromAddress).toBe("Cosmos <invites@example.com>");
    expect(arg.update.enabled).toBe(true);
    expect(arg.update.updatedById).toBe(ACTOR_ID);
    expect(arg.create.orgId).toBe(ORG_ID);

    // Response carries status booleans only — never the key.
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("re_new_secret");
  });

  it("leaves the existing sealed key UNTOUCHED when apiKey is omitted", async () => {
    await PUT(req("PUT", { enabled: false }), { params });

    const arg = prisma.orgEmailSettings.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(arg.update).not.toHaveProperty("apiKey");
    expect(arg.update.enabled).toBe(false);
    expect(arg.update.updatedById).toBe(ACTOR_ID);
  });

  it("leaves the existing sealed key UNTOUCHED when apiKey is an empty/whitespace string", async () => {
    await PUT(req("PUT", { apiKey: "   ", fromAddress: "invites@example.com" }), { params });

    const arg = prisma.orgEmailSettings.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(arg.update).not.toHaveProperty("apiKey");
    expect(arg.update.fromAddress).toBe("invites@example.com");
  });

  it("400 on a fromAddress that doesn't resemble an email / From header", async () => {
    const res = await PUT(req("PUT", { fromAddress: "not-an-email" }), { params });
    expect(res.status).toBe(400);
    expect(prisma.orgEmailSettings.upsert).not.toHaveBeenCalled();
  });

  it("accepts a bare email and a display-name From header", async () => {
    for (const from of ["invites@example.com", "Cosmos <invites@example.com>"]) {
      prisma.orgEmailSettings.upsert.mockClear();
      const res = await PUT(req("PUT", { fromAddress: from }), { params });
      expect(res.status).toBe(200);
      expect(prisma.orgEmailSettings.upsert).toHaveBeenCalledTimes(1);
    }
  });
});

describe("email-settings — OWNER gating + auth", () => {
  it("403 for a non-owner ADMIN that DOES hold ORG_MANAGE_SETTINGS (GET)", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.ADMIN }));
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(403);
    expect(prisma.orgEmailSettings.findUnique).not.toHaveBeenCalled();
  });

  it("403 for a non-owner ADMIN (PUT) — no write happens", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.ADMIN }));
    const res = await PUT(req("PUT", { apiKey: "re_x", fromAddress: "a@b.com", enabled: true }), { params });
    expect(res.status).toBe(403);
    expect(prisma.orgEmailSettings.upsert).not.toHaveBeenCalled();
  });

  it("403 for a MEMBER lacking ORG_MANAGE_SETTINGS entirely", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.MEMBER, permissions: bits("ORG_READ") }));
    const res = await PUT(req("PUT", { enabled: true }), { params });
    expect(res.status).toBe(403);
    expect(prisma.orgEmailSettings.upsert).not.toHaveBeenCalled();
  });

  it("401 when there is no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(401);
  });

  it("404 when the org does not exist", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(404);
  });
});
