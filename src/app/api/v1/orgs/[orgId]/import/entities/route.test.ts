// @vitest-environment node
//
// The ORG import door, at the HTTP layer.
//
// `ORG_IMPORT` is all this route asks for, and it is not a superset of the
// permissions the calendar's own routes require to write an event
// (`BOARD_UPDATE`) or to add a category (`ORG_MANAGE_SETTINGS`). The gate that
// says so lives in the engine, where both doors reach it — so what this file
// has to prove is the two things the ROUTE is responsible for:
//
//   1. the engine is handed the REAL caller, not a context assembled here. A
//      gate is only as good as the subject it reads, and `auth` is the subject.
//   2. the engine's refusal reaches the client as a 403 rather than a 500.
//
// The engine itself is mocked, deliberately: its decision is pinned by
// `entity-import.programEvent.db.test.ts` against a real database, and mocking
// it here is what isolates the route's own behaviour.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext, runEntityImport, mapRows, codeKeyError, prisma, getEnabledPluginSlugs } =
  vi.hoisted(() => ({
    getAuthContext: vi.fn(),
    runEntityImport: vi.fn(),
    mapRows: vi.fn(() => []),
    codeKeyError: vi.fn(() => null),
    getEnabledPluginSlugs: vi.fn(async () => [] as string[]),
    prisma: { organization: { findFirst: vi.fn() } },
  }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/import/entity-import", () => ({ runEntityImport, mapRows, codeKeyError }));
vi.mock("@/lib/plugins/enablement", () => ({ getEnabledPluginSlugs }));
vi.mock("@/lib/plugins/registry", () => ({
  PluginRegistry: { getAll: () => [] },
  PluginServerRegistry: { get: () => undefined },
}));

import { POST } from "./route";
import { ForbiddenError } from "@/lib/rbac/check";

const params = Promise.resolve({ orgId: "alpha" });

const post = () =>
  POST(
    new NextRequest("http://localhost:3000/api/v1/orgs/alpha/import/entities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: "programEvent",
        mode: "commit",
        mapping: { Title: "title" },
        rows: [{ Title: "anything" }],
      }),
    }),
    { params },
  );

/** Everything this route asks for, and nothing the engine asks for. */
const importerCtx = {
  orgId: "org-1",
  userId: "user-1",
  orgRole: "MEMBER",
  abacRules: [],
  permissions: Permission.ORG_IMPORT,
  basePermissions: Permission.ORG_IMPORT,
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findFirst.mockResolvedValue({ id: "org-1", slug: "alpha" });
  getAuthContext.mockResolvedValue(importerCtx);
  getEnabledPluginSlugs.mockResolvedValue([]);
  runEntityImport.mockResolvedValue({ total: 1, willCreate: 1, willUpdate: 0, skipped: 0, errors: [] });
});

describe("POST org import — the engine's gate reaches the client", () => {
  it("hands the engine the acting context, so the gate reads the real caller", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(runEntityImport).toHaveBeenCalledTimes(1);
    const [ctx] = runEntityImport.mock.calls[0];
    // Not a context built here: the same object the session resolved, carrying
    // this caller's own mask. Rebuilding one would silently re-grant whatever
    // the route happened to assume.
    expect(ctx.auth).toBe(importerCtx);
    expect(ctx.userId).toBe("user-1");
    expect(ctx.projectId).toBeNull();
  });

  it("answers 403 when the engine refuses the write", async () => {
    runEntityImport.mockRejectedValue(new ForbiddenError("Missing required permission"));
    const res = await post();
    expect(res.status).toBe(403);
  });

  it("still refuses a caller without ORG_IMPORT before reaching the engine", async () => {
    // The route's own gate, which the engine's gate does not replace.
    getAuthContext.mockResolvedValue({ ...importerCtx, permissions: 0n, basePermissions: 0n });
    const res = await post();
    expect(res.status).toBe(403);
    expect(runEntityImport).not.toHaveBeenCalled();
  });
});
