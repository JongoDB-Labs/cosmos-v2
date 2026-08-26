// @vitest-environment node
//
// The bug this file exists to prevent: an endpoint built for a scheduler,
// gated on a permission that NO api-key scope grants. It type-checks, its own
// tests pass with a hand-made context, the whole suite is green -- and the key
// you mint for the cron box gets 403 forever. Nothing else in the codebase
// connects the two halves, so this does.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import { scopeMask } from "@/lib/auth/api-key";
import { hasPermission, Permission, RolePermissions } from "@/lib/rbac/permissions";

describe("scheduler-callable endpoints", () => {
  it("a rules:run key can actually run rules", () => {
    expect(hasPermission(scopeMask(["rules:run"]), Permission.RULES_RUN)).toBe(true);
  });

  it("and can do NOTHING else -- not even read", () => {
    // A key that lives on a cron box should not be able to browse the org.
    const mask = scopeMask(["rules:run"]);
    for (const [name, bit] of Object.entries(Permission)) {
      if (name === "RULES_RUN") continue;
      expect(hasPermission(mask, bit as bigint), `rules:run must not grant ${name}`).toBe(false);
    }
  });

  it("no OTHER scope grants RULES_RUN by accident", () => {
    for (const scope of API_KEY_SCOPES) {
      if (scope === "rules:run") continue;
      expect(hasPermission(scopeMask([scope]), Permission.RULES_RUN), scope).toBe(false);
    }
  });

  it("RULES_RUN is not PLUGIN_MANAGE", () => {
    // Sharing the bit would let a cron key enable, disable and reconfigure
    // plugins, which is the whole reason this permission exists separately.
    expect(Permission.RULES_RUN).not.toBe(Permission.PLUGIN_MANAGE);
    expect(hasPermission(scopeMask(["rules:run"]), Permission.PLUGIN_MANAGE)).toBe(false);
  });

  it("an unknown scope grants nothing at all", () => {
    expect(scopeMask(["rules:run:extra", "nonsense"])).toBe(0n);
  });

  it("admins can trigger a run from the UI", () => {
    expect(hasPermission(RolePermissions.ADMIN, Permission.RULES_RUN)).toBe(true);
    expect(hasPermission(RolePermissions.OWNER, Permission.RULES_RUN)).toBe(true);
  });

  it("ordinary members cannot", () => {
    expect(hasPermission(RolePermissions.MEMBER, Permission.RULES_RUN)).toBe(false);
    expect(hasPermission(RolePermissions.VIEWER, Permission.RULES_RUN)).toBe(false);
  });

  it("every permission bit is distinct", () => {
    // Reusing a shift silently merges two permissions into one.
    const bits = Object.values(Permission);
    expect(new Set(bits.map(String)).size).toBe(bits.length);
  });
});

// The mapping tests above pin "rules:run grants RULES_RUN". They do NOT pin
// "the route asks for RULES_RUN" -- so on their own, re-gating the endpoint on
// PLUGIN_MANAGE would sail past them. This one drives the ACTUAL route with a
// mask derived from the scope, which is the thing that was broken.
const { resolveAuth, prisma, runOrgRules } = vi.hoisted(() => ({
  resolveAuth: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() } },
  runOrgRules: vi.fn(),
}));
vi.mock("@/lib/auth/api-key", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/api-key")>()),
  resolveAuth,
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rules/run", () => ({ runOrgRules }));

describe("a rules:run key against the real endpoint", () => {
  const ORG = "11111111-1111-1111-1111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.organization.findUnique.mockResolvedValue({ id: ORG });
    runOrgRules.mockResolvedValue({ ok: true, plugins: [] });
  });

  it("is not rejected by the route's gate", async () => {
    const { POST } = await import("@/app/api/v1/orgs/[orgId]/rules/run/route");
    resolveAuth.mockResolvedValue({
      orgId: ORG,
      userId: "u1",
      permissions: scopeMask(["rules:run"]),
    });
    const res = await POST(
      new NextRequest("http://localhost/x", { method: "POST" }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(res.status).toBe(200);
  });

  it("but a read-only key IS rejected", async () => {
    const { POST } = await import("@/app/api/v1/orgs/[orgId]/rules/run/route");
    resolveAuth.mockResolvedValue({ orgId: ORG, userId: "u1", permissions: scopeMask(["read"]) });
    const res = await POST(
      new NextRequest("http://localhost/x", { method: "POST" }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(res.status).toBe(403);
    expect(runOrgRules).not.toHaveBeenCalled();
  });
});
