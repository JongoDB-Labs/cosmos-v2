// @vitest-environment node
//
// Test-send route. Proves it sends to the CURRENT user via the org's resolved
// config (sendAppEmail with the orgId), returns { ok: true } on success and
// { ok: false, error } — HTTP 200, carrying the provider error text — on failure,
// and is OWNER-gated (a non-owner ADMIN is 403 and never sends).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, sendAppEmail } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  sendAppEmail: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/integrations/email-sender", () => ({ sendAppEmail }));
vi.mock("@/lib/brand", () => ({ getBrand: () => ({ name: "Cosmos" }) }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const params = Promise.resolve({ orgId: ORG_ID });

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

function post() {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/email-settings/test`, {
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.user.findUnique.mockResolvedValue({ email: "owner@example.com" });
  sendAppEmail.mockResolvedValue(undefined);
});

describe("POST /orgs/[orgId]/email-settings/test", () => {
  beforeEach(() => getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.OWNER })));

  it("sends to the current user via the org's resolved config and returns { ok: true }", async () => {
    const res = await POST(post(), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendAppEmail).toHaveBeenCalledTimes(1);
    const arg = sendAppEmail.mock.calls[0][0] as { to: string; orgId: string; subject: string };
    expect(arg.to).toBe("owner@example.com");
    expect(arg.orgId).toBe(ORG_ID); // resolves per-org config
    expect(arg.subject).toContain("Cosmos");
  });

  it("returns { ok: false, error } with the provider error text when the send fails (still HTTP 200)", async () => {
    sendAppEmail.mockRejectedValue(new Error("Resend send failed with HTTP 422: invalid `from` address"));

    const res = await POST(post(), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("422");
    expect(body.error).toContain("invalid `from` address");
  });

  it("returns { ok: false } when the current user has no email address", async () => {
    prisma.user.findUnique.mockResolvedValue({ email: null });

    const res = await POST(post(), { params });
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no email/i);
    expect(sendAppEmail).not.toHaveBeenCalled();
  });
});

describe("POST /orgs/[orgId]/email-settings/test — OWNER gating + auth", () => {
  it("403 for a non-owner ADMIN that holds ORG_MANAGE_SETTINGS — and never sends", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.ADMIN }));
    const res = await POST(post(), { params });
    expect(res.status).toBe(403);
    expect(sendAppEmail).not.toHaveBeenCalled();
  });

  it("401 when there is no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await POST(post(), { params });
    expect(res.status).toBe(401);
    expect(sendAppEmail).not.toHaveBeenCalled();
  });

  it("404 when the org does not exist", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    const res = await POST(post(), { params });
    expect(res.status).toBe(404);
  });
});
