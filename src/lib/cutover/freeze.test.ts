// src/lib/cutover/freeze.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  prisma: { frozenOrg: { findUnique } },
}));

import { isMutatingMethod, orgRefFromPath } from "./freeze";

describe("isMutatingMethod", () => {
  it("treats POST/PUT/PATCH/DELETE as mutating; GET/HEAD/OPTIONS as not", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "patch"]) {
      expect(isMutatingMethod(m)).toBe(true);
    }
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isMutatingMethod(m)).toBe(false);
    }
  });
});

describe("orgRefFromPath", () => {
  it("extracts an org id from the API form /api/v1/orgs/<uuid>/…", () => {
    const ref = orgRefFromPath("/api/v1/orgs/11111111-1111-1111-1111-111111111111/work-items");
    expect(ref).toEqual({ kind: "id", value: "11111111-1111-1111-1111-111111111111" });
  });

  it("extracts an org slug from the dashboard form /<slug>/…", () => {
    expect(orgRefFromPath("/acme/projects")).toEqual({ kind: "slug", value: "acme" });
    expect(orgRefFromPath("/acme")).toEqual({ kind: "slug", value: "acme" });
  });

  it("returns null for non-org API paths and known non-tenant prefixes", () => {
    expect(orgRefFromPath("/api/health")).toBeNull();
    expect(orgRefFromPath("/api/auth/logout")).toBeNull();
    expect(orgRefFromPath("/api/v1/me")).toBeNull();
    expect(orgRefFromPath("/login")).toBeNull();
    expect(orgRefFromPath("/onboarding")).toBeNull();
    expect(orgRefFromPath("/manifest.webmanifest")).toBeNull();
    expect(orgRefFromPath("/favicon.ico")).toBeNull();
  });
});

describe("isPathOrgFrozen + isOrgFrozen", () => {
  beforeEach(() => findUnique.mockReset());

  it("frozen slug ⇒ true (dashboard path)", async () => {
    findUnique.mockResolvedValue({ id: "x" });
    const { isPathOrgFrozen } = await import("./freeze");
    expect(await isPathOrgFrozen("/acme/projects")).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { orgSlug: "acme" }, select: { id: true } });
  });

  it("frozen id ⇒ true (API path resolves by orgId)", async () => {
    findUnique.mockResolvedValue({ id: "x" });
    const { isPathOrgFrozen } = await import("./freeze");
    const id = "11111111-1111-1111-1111-111111111111";
    expect(await isPathOrgFrozen(`/api/v1/orgs/${id}/notes`)).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { orgId: id }, select: { id: true } });
  });

  it("not frozen ⇒ false", async () => {
    findUnique.mockResolvedValue(null);
    const { isPathOrgFrozen } = await import("./freeze");
    expect(await isPathOrgFrozen("/acme/projects")).toBe(false);
  });

  it("non-org path ⇒ false WITHOUT hitting the DB", async () => {
    const { isPathOrgFrozen } = await import("./freeze");
    expect(await isPathOrgFrozen("/api/health")).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("isOrgFrozen(slug) reflects table presence", async () => {
    const { isOrgFrozen } = await import("./freeze");
    findUnique.mockResolvedValueOnce({ id: "x" });
    expect(await isOrgFrozen("acme")).toBe(true);
    findUnique.mockResolvedValueOnce(null);
    expect(await isOrgFrozen("acme")).toBe(false);
  });
});
