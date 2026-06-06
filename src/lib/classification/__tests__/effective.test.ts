// src/lib/classification/__tests__/effective.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { dataClassification: { findMany } } }));

describe("effectiveCeiling", () => {
  beforeEach(() => findMany.mockReset());

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
