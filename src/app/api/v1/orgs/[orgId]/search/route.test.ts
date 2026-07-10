// @vitest-environment node
//
// COSMOS-33 — the ⌘K palette is a GLOBAL search. The route must fan the query
// out across EVERY entity class the shared registry indexes (not the original
// four), pass the registry's canonical `EntityType` straight through, route
// people (who have no profile page) to the Team roster, and drop hits with no
// deep-link. Mocks are confined to the I/O + registry boundaries; the mapping
// logic under test runs for real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ENTITY_ORDER } from "@/lib/mentions/refs";
import type { EntityHit } from "@/lib/mentions/registry.server";

const { getAuthContext, requirePermission, searchEntities, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requirePermission: vi.fn(),
  searchEntities: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rbac/check", () => ({ requirePermission }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/mentions/registry.server", () => ({ searchEntities }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function req(qs = "?q=road"): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/search${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue({ userId: "user-1", orgId: ORG_ID });
  searchEntities.mockResolvedValue([]);
});

describe("GET /search — global palette search (COSMOS-33)", () => {
  it("fans the query out across every indexed entity class, not just the legacy four", async () => {
    await GET(req(), { params });

    expect(searchEntities).toHaveBeenCalledTimes(1);
    const arg = searchEntities.mock.calls[0][0] as { types: string[] };
    // The full registry order — a regression here (e.g. reverting to the old
    // 4-type list) fails the test.
    expect(arg.types).toEqual(ENTITY_ORDER);
    for (const t of ["document", "objective", "board", "milestone", "risk", "user", "kpi"]) {
      expect(arg.types).toContain(t);
    }
  });

  it("passes the registry's canonical EntityType straight through (no legacy remap)", async () => {
    const hits: EntityHit[] = [
      { type: "workItem", id: "w1", label: "FSC-1 · Ship it", url: "/acme/issues?item=w1" },
      { type: "document", id: "d1", label: "Design", url: "/acme/projects/FSC/files/d1" },
      { type: "objective", id: "o1", label: "Grow", url: "/acme/projects/FSC/okrs" },
    ];
    searchEntities.mockResolvedValue(hits);

    const res = await GET(req(), { params });
    const body = (await res.json()) as { id: string; type: string; name: string; url: string }[];

    expect(body).toEqual([
      { id: "w1", type: "workItem", name: "FSC-1 · Ship it", url: "/acme/issues?item=w1" },
      { id: "d1", type: "document", name: "Design", url: "/acme/projects/FSC/files/d1" },
      { id: "o1", type: "objective", name: "Grow", url: "/acme/projects/FSC/okrs" },
    ]);
  });

  it("routes people (no profile page) to the Team roster and drops unnavigable hits", async () => {
    const hits: EntityHit[] = [
      { type: "user", id: "u1", label: "Ada Lovelace", url: null },
      // A project-scoped hit whose owning project was deleted → no deep-link.
      { type: "risk", id: "r1", label: "Orphan risk", url: null },
      { type: "project", id: "p1", label: "Apollo", url: "/acme/projects/APOLLO" },
    ];
    searchEntities.mockResolvedValue(hits);

    const res = await GET(req(), { params });
    const body = (await res.json()) as { id: string; type: string; url: string }[];

    expect(body).toEqual([
      { id: "u1", type: "user", name: "Ada Lovelace", url: "/acme/team" },
      { id: "p1", type: "project", name: "Apollo", url: "/acme/projects/APOLLO" },
    ]);
    // The orphaned, unnavigable risk hit is filtered out entirely.
    expect(body.some((r) => r.id === "r1")).toBe(false);
  });

  it("short-circuits an empty query without touching the registry", async () => {
    const res = await GET(req("?q=  "), { params });
    const body = (await res.json()) as unknown[];

    expect(body).toEqual([]);
    expect(searchEntities).not.toHaveBeenCalled();
  });
});
