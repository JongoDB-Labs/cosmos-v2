// @vitest-environment node
//
// Per-org Foreman build-harness settings route. Proves:
//   - GET returns the defaults (enabled:true, systemPromptAppend:null) when no
//     row exists yet, and the stored row's values once one does;
//   - PUT upserts { enabled, systemPromptAppend } and stamps updatedById, then
//     returns the freshly-read settings;
//   - a caller without ORG_MANAGE_SETTINGS is 403 on both routes (no write);
//   - 401 with no auth context, 404 when the org doesn't exist.
//
// Mocks only the I/O boundaries (session, db) — mirrors the mocking idiom from
// email-settings/route.test.ts, adapted for the simpler (non-OWNER) gate used by
// foreman/supervisor and foreman/harness.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    foremanHarnessSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET, PUT } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const params = Promise.resolve({ orgId: ORG_ID });

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: { permissions?: bigint; orgRole?: OrgRole }): AuthContext {
  const perms = opts.permissions ?? bits("ORG_READ", "ORG_MANAGE_SETTINGS");
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole ?? OrgRole.ADMIN,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

function req(method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/foreman/harness`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.foremanHarnessSettings.upsert.mockResolvedValue({});
});

describe("GET /orgs/[orgId]/foreman/harness", () => {
  beforeEach(() => getAuthContext.mockResolvedValue(ctxWith({})));

  it("returns the defaults (enabled:true, systemPromptAppend:null) when no row exists", async () => {
    prisma.foremanHarnessSettings.findUnique.mockResolvedValue(null);

    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, systemPromptAppend: null });
  });

  it("returns the stored row's values", async () => {
    prisma.foremanHarnessSettings.findUnique.mockResolvedValue({
      enabled: false,
      systemPromptAppend: "Always run lint before committing.",
    });

    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      systemPromptAppend: "Always run lint before committing.",
    });
  });
});

describe("PUT /orgs/[orgId]/foreman/harness", () => {
  beforeEach(() => {
    getAuthContext.mockResolvedValue(ctxWith({}));
    prisma.foremanHarnessSettings.findUnique.mockResolvedValue({
      enabled: false,
      systemPromptAppend: "Custom append.",
    });
  });

  it("upserts { enabled, systemPromptAppend } and stamps updatedById, returning the freshly-read settings", async () => {
    const res = await PUT(
      req("PUT", { enabled: false, systemPromptAppend: "Custom append." }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(prisma.foremanHarnessSettings.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.foremanHarnessSettings.upsert.mock.calls[0][0] as {
      where: { orgId: string };
      create: { orgId: string; enabled: boolean; systemPromptAppend: string | null; updatedById: string };
      update: { enabled: boolean; systemPromptAppend: string | null; updatedById: string };
    };
    expect(arg.where).toEqual({ orgId: ORG_ID });
    expect(arg.create).toEqual({
      orgId: ORG_ID,
      enabled: false,
      systemPromptAppend: "Custom append.",
      updatedById: ACTOR_ID,
    });
    expect(arg.update).toEqual({
      enabled: false,
      systemPromptAppend: "Custom append.",
      updatedById: ACTOR_ID,
    });

    expect(await res.json()).toEqual({ enabled: false, systemPromptAppend: "Custom append." });
  });

  it("accepts a null systemPromptAppend", async () => {
    prisma.foremanHarnessSettings.findUnique.mockResolvedValue({
      enabled: true,
      systemPromptAppend: null,
    });

    const res = await PUT(req("PUT", { enabled: true, systemPromptAppend: null }), { params });
    expect(res.status).toBe(200);
    const arg = prisma.foremanHarnessSettings.upsert.mock.calls[0][0] as {
      update: { systemPromptAppend: string | null };
    };
    expect(arg.update.systemPromptAppend).toBeNull();
  });

  it("400 on a systemPromptAppend over 4000 chars", async () => {
    const res = await PUT(
      req("PUT", { enabled: true, systemPromptAppend: "x".repeat(4001) }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.foremanHarnessSettings.upsert).not.toHaveBeenCalled();
  });
});

describe("foreman/harness — auth", () => {
  it("403 for a caller lacking ORG_MANAGE_SETTINGS (GET)", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ORG_READ") }));
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(403);
    expect(prisma.foremanHarnessSettings.findUnique).not.toHaveBeenCalled();
  });

  it("403 for a caller lacking ORG_MANAGE_SETTINGS (PUT) — no write happens", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ORG_READ") }));
    const res = await PUT(req("PUT", { enabled: true, systemPromptAppend: null }), { params });
    expect(res.status).toBe(403);
    expect(prisma.foremanHarnessSettings.upsert).not.toHaveBeenCalled();
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
