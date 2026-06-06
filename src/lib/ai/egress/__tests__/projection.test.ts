// src/lib/ai/egress/__tests__/projection.test.ts
import { describe, it, expect } from "vitest";
import { projectStructural, entityTypeForTool } from "../projection";

describe("projectStructural", () => {
  it("keeps allowlisted structural fields, drops free text (work_item)", () => {
    const wi = { id: "u1", title: "CUI//SP Sentinel kill chain", description: "secret", status: "DONE", priority: "HIGH", dueDate: "2026-07-01" };
    const mv = projectStructural(wi, "work_item") as Record<string, unknown>;
    expect(mv).toEqual({ id: "u1", status: "DONE", priority: "HIGH", dueDate: "2026-07-01" });
    expect(JSON.stringify(mv)).not.toContain("Sentinel");
    expect(JSON.stringify(mv)).not.toContain("secret");
  });

  it("maps arrays element-wise", () => {
    const arr = [{ id: "a", title: "x" }, { id: "b", title: "y" }];
    expect(projectStructural(arr, "work_item")).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("search results expose id/type/similarity but NEVER the snippet", () => {
    const hit = { id: "n1", type: "note", similarity: 0.82, title: "CUI title", snippet: "CUI body text" };
    const mv = projectStructural(hit, "search_result") as Record<string, unknown>;
    expect(mv).toEqual({ id: "n1", type: "note", similarity: 0.82 });
    expect(JSON.stringify(mv)).not.toContain("CUI");
  });

  it("unknown entityType ⇒ full withhold (default-deny)", () => {
    expect(projectStructural({ id: "x", foo: "bar" }, "mystery")).toEqual({ withheld: true, ref: "withheld:structural" });
  });

  it("a bare string / non-entity ⇒ full withhold", () => {
    expect(projectStructural("CUI//free text", "work_item")).toEqual({ withheld: true, ref: "withheld:structural" });
  });

  it("entityTypeForTool maps read+mutation tools; unknown ⇒ undefined", () => {
    expect(entityTypeForTool("list_work_items")).toBe("work_item");
    expect(entityTypeForTool("semantic_search")).toBe("search_result");
    expect(entityTypeForTool("fetch_url")).toBeUndefined();
  });

  it("nested objects are NOT recursed into (only top-level allowlisted scalars survive)", () => {
    const wi = { id: "u1", status: "DONE", assignee: { id: "z", name: "CUI Person" } };
    const mv = projectStructural(wi, "work_item") as Record<string, unknown>;
    expect(mv).toEqual({ id: "u1", status: "DONE" }); // `assignee` object not allowlisted → dropped
    expect(JSON.stringify(mv)).not.toContain("CUI Person");
  });
});
