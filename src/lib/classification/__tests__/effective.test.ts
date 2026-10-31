// src/lib/classification/__tests__/effective.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { dataClassification: { findMany } } }));

describe("effectiveCeiling", () => {
  // A BLOCK body, not `() => findMany.mockReset()`: an arrow-bodied hook RETURNS
  // the mock, and vitest calls whatever a hook returns as that test's cleanup —
  // invoking findMany() with NO arguments after every test. Invisible with a
  // mockResolvedValue stub; it throws inside any mockImplementation that reads its
  // argument (which is how it was found).
  beforeEach(() => {
    findMany.mockReset();
  });

  it("returns the MAX of the org-ceiling row and the project row", async () => {
    findMany.mockResolvedValue([
      { projectId: null, level: "FOUO" },          // org ceiling
      { projectId: "p1", level: "CUI" },           // project
    ]);
    const { effectiveCeiling } = await import("../effective");
    expect(await effectiveCeiling("o1", "p1")).toBe("CUI");
  });

  it("defaults to UNCLASSIFIED when nothing is set (NOT public — conservative)", async () => {
    findMany.mockResolvedValue([]);
    const { effectiveCeiling } = await import("../effective");
    expect(await effectiveCeiling("o1", "p1")).toBe("UNCLASSIFIED");
  });

  it("uses the org ceiling when no project is given", async () => {
    findMany.mockResolvedValue([{ projectId: null, level: "CUI" }]);
    const { effectiveCeiling } = await import("../effective");
    expect(await effectiveCeiling("o1")).toBe("CUI");
  });
});

describe("conservativeCeiling", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("returns the MAX over the org row AND every project row", async () => {
    findMany.mockResolvedValue([
      { projectId: null, level: "UNCLASSIFIED" }, // org ceiling
      { projectId: "p1", level: "CUI" },          // one project sits above it
      { projectId: "p2", level: "PUBLIC" },
    ]);
    const { conservativeCeiling } = await import("../effective");
    expect(await conservativeCeiling("o1")).toBe("CUI");
  });

  it("asks for the org's rows with NO project predicate — there is no argument model input could steer", async () => {
    findMany.mockResolvedValue([{ projectId: null, level: "UNCLASSIFIED" }]);
    const { conservativeCeiling } = await import("../effective");
    await conservativeCeiling("o1");
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ orgId: "o1" });
  });

  it("defaults to UNCLASSIFIED when the org has no rows (NOT public — conservative)", async () => {
    findMany.mockResolvedValue([]);
    const { conservativeCeiling } = await import("../effective");
    expect(await conservativeCeiling("o1")).toBe("UNCLASSIFIED");
  });

  it("is never LOWER than effectiveCeiling for any project in the org", async () => {
    // The ordering the read-path fix rests on: swapping effectiveCeiling(org, p) for
    // conservativeCeiling(org) can only ever RAISE the gate ceiling, never lower it.
    // REAL uuids: `effectiveCeiling` drops a non-uuid from its predicate, so "p1"
    // would silently compare the org row against itself.
    const P1 = "11111111-1111-4111-8111-111111111111";
    const P2 = "22222222-2222-4222-8222-222222222222";
    const rows = [
      { projectId: null, level: "UNCLASSIFIED" },
      { projectId: P1, level: "FOUO" },
      { projectId: P2, level: "CONFIDENTIAL" },
    ];
    const { conservativeCeiling, effectiveCeiling, rankOf } = await import("../effective");
    findMany.mockImplementation(async (args: { where: { OR?: Array<{ projectId: string | null }> } }) => {
      const where = args.where;
      return where.OR ? rows.filter((r) => where.OR!.some((c) => c.projectId === r.projectId)) : rows;
    });
    const conservative = await conservativeCeiling("o1");
    expect(conservative).toBe("CONFIDENTIAL");
    // POSITIVE CONTROL that the per-project predicate really discriminates here —
    // otherwise every comparison below is org-row-vs-org-row and proves nothing.
    expect(await effectiveCeiling("o1", P1)).toBe("FOUO");
    for (const p of [undefined, P1, P2, "33333333-3333-4333-8333-333333333333"]) {
      expect(rankOf(conservative)).toBeGreaterThanOrEqual(rankOf(await effectiveCeiling("o1", p)));
    }
  });
});
