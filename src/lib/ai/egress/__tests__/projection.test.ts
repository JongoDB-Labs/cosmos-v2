// src/lib/ai/egress/__tests__/projection.test.ts
import { describe, it, expect } from "vitest";
import { projectStructural, projectResult, entityTypeForTool } from "../projection";

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

describe("projectResult (wrapper unwrap — what the loop uses)", () => {
  it("unwraps a {count, items:[...]} wrapper element-wise, keeps the count, drops free text", () => {
    // listWorkItems returns this exact wrapper shape.
    const result = {
      count: 2,
      items: [
        { id: "w1", title: "CUI//SP kill chain", columnKey: "doing", status: "DOING", priority: "HIGH" },
        { id: "w2", title: "CUI//SP exfil", columnKey: "done", status: "DONE", priority: "LOW" },
      ],
    };
    const mv = projectResult(result, "work_item") as Record<string, unknown>;
    expect(mv).toEqual({
      count: 2,
      items: [
        { id: "w1", status: "DOING", priority: "HIGH" },
        { id: "w2", status: "DONE", priority: "LOW" },
      ],
    });
    // count (number) survives; titles + columnKey (free text) are gone.
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("kill chain");
    expect(JSON.stringify(mv)).not.toContain("doing"); // columnKey dropped (FIX A)
  });

  it("drops a free-text wrapper field (semanticSearch echoes `query`) while keeping results+count", () => {
    const result = {
      query: "CUI//SP search term",
      count: 1,
      results: [{ id: "n1", type: "note", title: "CUI title", snippet: "CUI body", similarity: 0.8 }],
    };
    const mv = projectResult(result, "search_result") as Record<string, unknown>;
    expect(mv).toEqual({ count: 1, results: [{ id: "n1", type: "note", similarity: 0.8 }] });
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect("query" in mv).toBe(false); // echoed free-text query dropped
  });

  it("unknown entityType (finance) ⇒ FULL withhold even for a numeric wrapper", () => {
    expect(projectResult({ total: 5000, currency: "USD" }, entityTypeForTool("get_finance_summary"))).toEqual({
      withheld: true,
      ref: "withheld:structural",
    });
  });

  it("a bare entity[] result is projected element-wise", () => {
    expect(projectResult([{ id: "a", title: "x" }], "work_item")).toEqual([{ id: "a" }]);
  });

  it("a bare string result ⇒ FULL withhold (non-entity)", () => {
    expect(projectResult("CUI//SP secret", "work_item")).toEqual({ withheld: true, ref: "withheld:structural" });
  });
});
