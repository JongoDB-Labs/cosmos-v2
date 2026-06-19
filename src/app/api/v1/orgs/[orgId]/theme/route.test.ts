// @vitest-environment node
//
// RBAC + validation for the org Themes PATCH route (Phase 2). Proves:
//   - a caller WITHOUT THEME_MANAGE gets 403 (no DB write);
//   - 401 when there's no auth context;
//   - a THEME_MANAGE admin (NOT necessarily OWNER) CAN update brand fields;
//   - an invalid defaultSkinId ⇒ 400 (no DB write);
//   - the 5 new brand fields persist; null clears them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, revalidateOrg } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
  },
  revalidateOrg: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/cache/queries", () => ({ revalidateOrg }));

import { PATCH } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function ctx(perms: bigint): AuthContext {
  return {
    userId: "44444444-4444-4444-4444-444444444444",
    orgId: ORG_ID,
    orgRole: OrgRole.ADMIN,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}
function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/theme`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.organization.update.mockResolvedValue({ id: ORG_ID });
});

describe("theme route — RBAC", () => {
  it("403 for a caller WITHOUT THEME_MANAGE", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    const res = await PATCH(patch({ brandName: "Acme" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("401 when there's no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await PATCH(patch({ brandName: "Acme" }), { params });
    expect(res.status).toBe(401);
  });

  it("404 when the org does not exist", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    getAuthContext.mockResolvedValue(ctx(Permission.THEME_MANAGE));
    const res = await PATCH(patch({ brandName: "Acme" }), { params });
    expect(res.status).toBe(404);
  });
});

describe("theme route — brand updates (with THEME_MANAGE)", () => {
  beforeEach(() => {
    getAuthContext.mockResolvedValue(ctx(Permission.THEME_MANAGE));
  });

  it("persists the 5 brand fields ⇒ 200", async () => {
    const res = await PATCH(
      patch({
        brandName: "Acme Studio",
        agentName: "Acme Helper",
        tagline: "Build beautifully",
        wakeWord: "Hey Acme",
        defaultSkinId: "atelier",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const arg = prisma.organization.update.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      brandName: "Acme Studio",
      agentName: "Acme Helper",
      tagline: "Build beautifully",
      wakeWord: "Hey Acme",
      defaultSkinId: "atelier",
    });
    expect(revalidateOrg).toHaveBeenCalledWith({ id: ORG_ID, slug: "acme" });
  });

  it("an UNKNOWN defaultSkinId ⇒ 400, no DB write", async () => {
    const res = await PATCH(patch({ defaultSkinId: "not_a_skin" }), { params });
    expect(res.status).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it("null clears a brand field (explicit reset)", async () => {
    const res = await PATCH(patch({ brandName: null, defaultSkinId: null }), { params });
    expect(res.status).toBe(200);
    const arg = prisma.organization.update.mock.calls[0][0];
    expect(arg.data.brandName).toBeNull();
    expect(arg.data.defaultSkinId).toBeNull();
  });

  it("still accepts the legacy themePrimary/themeMode/logoUrl trio", async () => {
    const res = await PATCH(
      patch({ themePrimary: "#7C5CFF", themeMode: "dark", logoUrl: null }),
      { params },
    );
    expect(res.status).toBe(200);
    const arg = prisma.organization.update.mock.calls[0][0];
    expect(arg.data).toMatchObject({ themePrimary: "#7C5CFF", themeMode: "dark", logoUrl: null });
  });
});
