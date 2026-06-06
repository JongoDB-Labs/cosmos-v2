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

  it("github tools map to structural-only entity types (gov sees number/state, NOT title/body)", () => {
    expect(entityTypeForTool("github_list_issues")).toBe("github_issue");
    expect(entityTypeForTool("github_get_issue")).toBe("github_issue");
    expect(entityTypeForTool("github_list_pull_requests")).toBe("github_pull_request");
    // google tools remain unmapped → full withhold for gov.
    expect(entityTypeForTool("read_email")).toBeUndefined();
  });

  it("a github issue is projected to number/state/timestamps — title + body WITHHELD", () => {
    const issue = {
      number: 42,
      state: "open",
      title: "CUI//SP exfil path in sensor fusion",
      body: "secret repro steps with controlled data",
      labels: ["bug", "CUI"],
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-02T00:00:00Z",
      closedAt: null,
    };
    const mv = projectStructural(issue, "github_issue") as Record<string, unknown>;
    expect(mv).toEqual({
      number: 42,
      state: "open",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-02T00:00:00Z",
    });
    // title/body never survive; labels (array) dropped; null closedAt dropped.
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("exfil");
    expect(JSON.stringify(mv)).not.toContain("secret repro");
    expect(JSON.stringify(mv)).not.toContain("bug");
  });

  it("a github PR exposes number/state/draft/timestamps but NOT the title", () => {
    const pr = {
      number: 7,
      state: "open",
      title: "CUI//SP classified branch merge",
      draft: true,
      createdAt: "2026-06-03T00:00:00Z",
      updatedAt: "2026-06-04T00:00:00Z",
      closedAt: null,
      mergedAt: null,
    };
    const mv = projectStructural(pr, "github_pull_request") as Record<string, unknown>;
    expect(mv).toEqual({
      number: 7,
      state: "open",
      draft: true,
      createdAt: "2026-06-03T00:00:00Z",
      updatedAt: "2026-06-04T00:00:00Z",
    });
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("classified");
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

  it("unwraps a github_list_issues {count, issues:[...]} wrapper — drops titles/bodies/labels", () => {
    // githubListIssues returns this exact wrapper shape.
    const result = {
      success: true,
      count: 2,
      issues: [
        { number: 1, state: "open", title: "CUI//SP kill chain", labels: ["bug"], createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", closedAt: null },
        { number: 2, state: "closed", title: "CUI//SP exfil", labels: [], createdAt: "2026-06-02T00:00:00Z", updatedAt: "2026-06-03T00:00:00Z", closedAt: "2026-06-03T00:00:00Z" },
      ],
    };
    const mv = projectResult(result, "github_issue") as Record<string, unknown>;
    expect(mv).toEqual({
      success: true, // boolean wrapper flag kept
      count: 2, // number wrapper field kept
      issues: [
        { number: 1, state: "open", createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" },
        { number: 2, state: "closed", createdAt: "2026-06-02T00:00:00Z", updatedAt: "2026-06-03T00:00:00Z", closedAt: "2026-06-03T00:00:00Z" },
      ],
    });
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("kill chain");
    expect(JSON.stringify(mv)).not.toContain("bug"); // labels array dropped
  });

  it("unwraps a github_get_issue {issue:{...}} single-object wrapper", () => {
    // githubGetIssue wraps the single issue under `issue` (an object, not array) →
    // projectResult drops nested objects in the wrapper (default-deny), so a gov
    // single-get yields ONLY the structural wrapper flags. (The exposed/commercial
    // path returns the full value; the structural floor here is intentionally tight.)
    const result = { success: true, issue: { number: 9, state: "open", title: "CUI secret", body: "more CUI" } };
    const mv = projectResult(result, "github_issue") as Record<string, unknown>;
    expect(mv).toEqual({ success: true }); // nested `issue` object dropped → no CUI leak
    expect(JSON.stringify(mv)).not.toContain("CUI");
  });
});
