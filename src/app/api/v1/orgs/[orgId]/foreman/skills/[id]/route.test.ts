// @vitest-environment node
//
// Foreman skills manager single-row route (PATCH/DELETE by id). Proves the
// priv-esc guard that route.ts's gate() comment calls out:
//   - an ORG-scoped skill belonging to THIS org may be PATCHed/DELETEd by an
//     ordinary org admin (requireSystemAdmin is never even consulted / may
//     return null and it still succeeds);
//   - a PROJECT-WIDE skill (orgId: null) is injected into EVERY org's build
//     agents, so a non-platform-admin caller (requireSystemAdmin -> null)
//     gets 403 and prisma.update/delete is NEVER called;
//   - another org's skill (orgId: some other org) is invisible -> 404, and
//     prisma.update/delete is NEVER called.
//
// Mocks only the I/O boundaries (session, requireSystemAdmin, db) — mirrors
// the mocking idiom from foreman/skills/route.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { getAuthContext, requireSystemAdmin, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requireSystemAdmin: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    foremanSkill: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/internal/require-system-admin", () => ({ requireSystemAdmin }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { PATCH, DELETE } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const SKILL_ID = "33333333-3333-3333-3333-333333333333";
const params = Promise.resolve({ orgId: ORG_ID, id: SKILL_ID });

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
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/foreman/skills/${SKILL_ID}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith({}));
  requireSystemAdmin.mockResolvedValue(null);
});

describe("PATCH/DELETE /orgs/[orgId]/foreman/skills/[id] — priv-esc guard", () => {
  it("PATCH succeeds on an ORG-scoped skill of THIS org even when requireSystemAdmin returns null", async () => {
    prisma.foremanSkill.findUnique.mockResolvedValue({ orgId: ORG_ID });
    prisma.foremanSkill.update.mockResolvedValue({ id: SKILL_ID, enabled: false });

    const res = await PATCH(req("PATCH", { enabled: false }), { params });

    expect(res.status).toBe(200);
    expect(prisma.foremanSkill.update).toHaveBeenCalledTimes(1);
  });

  it("DELETE succeeds on an ORG-scoped skill of THIS org even when requireSystemAdmin returns null", async () => {
    prisma.foremanSkill.findUnique.mockResolvedValue({ orgId: ORG_ID });
    prisma.foremanSkill.delete.mockResolvedValue({ id: SKILL_ID });

    const res = await DELETE(req("DELETE"), { params });

    expect(res.status).toBe(204);
    expect(prisma.foremanSkill.delete).toHaveBeenCalledTimes(1);
  });

  it("PATCH on a PROJECT-wide skill (orgId: null) by a non-platform-admin is 403 — no write happens", async () => {
    prisma.foremanSkill.findUnique.mockResolvedValue({ orgId: null });
    requireSystemAdmin.mockResolvedValue(null);

    const res = await PATCH(req("PATCH", { enabled: false }), { params });

    expect(res.status).toBe(403);
    expect(prisma.foremanSkill.update).not.toHaveBeenCalled();
  });

  it("DELETE on a PROJECT-wide skill (orgId: null) by a non-platform-admin is 403 — no write happens", async () => {
    prisma.foremanSkill.findUnique.mockResolvedValue({ orgId: null });
    requireSystemAdmin.mockResolvedValue(null);

    const res = await DELETE(req("DELETE"), { params });

    expect(res.status).toBe(403);
    expect(prisma.foremanSkill.delete).not.toHaveBeenCalled();
  });

  it("PATCH on another org's skill is 404 — no write happens", async () => {
    prisma.foremanSkill.findUnique.mockResolvedValue({ orgId: OTHER_ORG_ID });

    const res = await PATCH(req("PATCH", { enabled: false }), { params });

    expect(res.status).toBe(404);
    expect(prisma.foremanSkill.update).not.toHaveBeenCalled();
  });

  it("DELETE on another org's skill is 404 — no write happens", async () => {
    prisma.foremanSkill.findUnique.mockResolvedValue({ orgId: OTHER_ORG_ID });

    const res = await DELETE(req("DELETE"), { params });

    expect(res.status).toBe(404);
    expect(prisma.foremanSkill.delete).not.toHaveBeenCalled();
  });
});

describe("foreman/skills/[id] — auth/not-found", () => {
  it("401 when there is no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await PATCH(req("PATCH", { enabled: false }), { params });
    expect(res.status).toBe(401);
  });

  it("404 when the org does not exist", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    const res = await PATCH(req("PATCH", { enabled: false }), { params });
    expect(res.status).toBe(404);
  });

  it("403 for a caller lacking ORG_MANAGE_SETTINGS", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ORG_READ") }));
    const res = await PATCH(req("PATCH", { enabled: false }), { params });
    expect(res.status).toBe(403);
    expect(prisma.foremanSkill.update).not.toHaveBeenCalled();
  });
});
