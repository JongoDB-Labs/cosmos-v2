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
    // githubGetIssue wraps the single issue under `issue` — an object, not an
    // array. This test's NAME always said "unwraps"; its assertion used to say
    // the opposite, pinning `{success: true}` and calling the floor
    // "intentionally tight". It was not tight, it was blank: the nested object
    // was dropped wholesale without the allowlist ever being read, so a gov
    // single-get answered with wrapper flags and no issue at all.
    //
    // Nested objects now go through the SAME allowlist as array elements. The
    // CUI assertion below is unchanged and still passes — which is the point:
    // what the model gains is exactly the allowlisted structural fields, and
    // `title`/`body` drop by default-deny as they always did.
    const result = { success: true, issue: { number: 9, state: "open", title: "CUI secret", body: "more CUI" } };
    const mv = projectResult(result, "github_issue") as Record<string, unknown>;
    expect(mv).toEqual({ success: true, issue: { number: 9, state: "open" } });
    expect(JSON.stringify(mv)).not.toContain("CUI");
  });
});

/**
 * The four tools that joined the map with NO new allowlisted field.
 *
 * Each returns the same shape a tool already mapped to the same entity
 * returns, plus one or two fields the floor had already analysed and
 * excluded. So the mapping is free: there is nothing new to verify, only
 * something to prove stays out. Which is what this does — the whole point of
 * the shrink-only ratchet in native-tool-entity.arch.test.ts is that an entry
 * leaves it for a REASON, and the reason has to be checkable.
 *
 * Every case carries a positive control: a projection that returns {} would
 * pass a leak assertion trivially, so each one also asserts the structural
 * field that SHOULD survive.
 */
describe("the four free mappings leak nothing", () => {
  it("are actually wired to those entities", () => {
    // Without this the four tests below prove a property of `projectResult`
    // and nothing about whether these tools reach it at all.
    expect(entityTypeForTool("list_blockers")).toBe("blocker");
    expect(entityTypeForTool("list_deliverables")).toBe("deliverable");
    expect(entityTypeForTool("list_changes")).toBe("change_request");
    expect(entityTypeForTool("archive_work_item")).toBe("work_item");
  });

  it("list_blockers keeps the handles, drops the title and the owner", () => {
    const out = projectResult(
      { count: 1, blockers: [{ id: "b1", code: "BLK-1", title: "classified title", type: "TECHNICAL", status: "OPEN", owner: "Jane Doe" }] },
      "blocker",
    ) as { count: number; blockers: Record<string, unknown>[] };

    expect(out.blockers[0]).toEqual({ id: "b1", code: "BLK-1", type: "TECHNICAL", status: "OPEN" });
    expect(JSON.stringify(out)).not.toContain("classified title");
    expect(JSON.stringify(out)).not.toContain("Jane Doe");
    expect(out.count).toBe(1); // control: the wrapper survived, so the above is a real absence
  });

  it("list_deliverables drops the CLIN, which names a contract line item", () => {
    const out = projectResult(
      { count: 1, deliverables: [{ id: "d1", code: "CDRL-1", title: "t", clin: "0001AA", status: "DRAFT", owner: "Jane Doe", baselineDue: "2026-01-01" }] },
      "deliverable",
    ) as { deliverables: Record<string, unknown>[] };

    expect(out.deliverables[0]).toEqual({ id: "d1", code: "CDRL-1", status: "DRAFT", baselineDue: "2026-01-01" });
    expect(JSON.stringify(out)).not.toContain("0001AA");
  });

  it("a CDRL keeps its contract and sprint IDS but never the objective text or the gate", () => {
    const out = projectResult(
      {
        updated: true,
        deliverable: {
          id: "d2", code: "CDRL-2", status: "DRAFT", projectId: "p1",
          contractId: "ct1", intervalId: "iv1", milestoneId: "ms1",
          piObjective: "Reduce reporting turnaround", dueGate: "SD-1",
          title: "classified title", owner: "Jane Doe",
        },
      },
      "deliverable",
    ) as { updated: boolean; deliverable: Record<string, unknown> };

    // Structural ids survive — they are what lets the agent walk "which CDRLs
    // sit under this contract, which are planned into this sprint".
    expect(out.deliverable).toEqual({
      id: "d2", code: "CDRL-2", status: "DRAFT", projectId: "p1",
      contractId: "ct1", intervalId: "iv1", milestoneId: "ms1",
    });
    // The two new free-text columns are content: the objective is the
    // programme's own words and the gate names a customer event.
    expect(JSON.stringify(out)).not.toContain("Reduce reporting turnaround");
    expect(JSON.stringify(out)).not.toContain("SD-1");
    expect(out.updated).toBe(true); // control: the wrapper survived
  });

  it("list_changes keeps the schedule days and drops the cost", () => {
    const out = projectResult(
      { count: 1, changes: [{ id: "c1", code: "CR-1", title: "t", type: "SCOPE", status: "OPEN", costImpact: 50000, scheduleDaysImpact: 5 }] },
      "change_request",
    ) as { changes: Record<string, unknown>[] };

    // The floor's existing stance on money, unchanged: days yes, dollars no.
    expect(out.changes[0]).toEqual({ id: "c1", code: "CR-1", status: "OPEN", scheduleDaysImpact: 5 });
    expect(JSON.stringify(out)).not.toContain("50000");
  });

  it("archive_work_item drops the title, exactly as delete_work_item does", () => {
    const archived = projectResult({ id: "w1", ticketNumber: 7, title: "classified title", archived: true }, "work_item");
    const deleted = projectResult({ deleted: true, id: "w1", ticketNumber: 7, title: "classified title" }, "work_item");

    expect(JSON.stringify(archived)).not.toContain("classified title");
    expect(JSON.stringify(deleted)).not.toContain("classified title");
    // This is the witness left behind when these four were mapped: both used
    // to lose their own `id`, because projectResult kept only numbers and
    // booleans at the top level and never consulted the allowlist for a bare
    // entity. That defect is fixed, so `id` is back — and the day it is read,
    // this expectation is what says these two were among the ~30 affected.
    expect(archived).toEqual({ id: "w1", ticketNumber: 7, archived: true });
    expect(deleted).toEqual({ id: "w1", deleted: true, ticketNumber: 7 });
  });
});

/**
 * The single-entity return, which `projectResult` never handled.
 *
 * Every branch of the object case treated the top-level object as a WRAPPER
 * around entities: arrays were allowlisted element-wise, numbers and booleans
 * were kept as structural metadata, and everything else was dropped. A tool
 * returning ONE entity flat fell through all of it, because an entity's `id`
 * is a string — so `get_work_item` answered `{ticketNumber: 7}` and the
 * allowlist was never consulted at all. ~30 tools were mapped and still
 * effectively blank, which is worse than unmapped because the map looked
 * complete.
 *
 * The property that makes the fix safe is that `projectOne` iterates the
 * ALLOWLIST, not the source keys. Running it over a wrapper is a no-op,
 * because `count` and `items` are not entity field names.
 */
describe("a single entity is projected, not dropped", () => {
  it("get_work_item keeps its id and structural fields, and still loses the body", () => {
    const item = {
      id: "w-uuid", ticketNumber: 7, status: "IN_PROGRESS", priority: "HIGH", storyPoints: 3,
      title: "CUI title", description: "the ticket body, which is content",
      assigneeName: "Jane Doe",
    };
    const out = projectResult(item, "work_item") as Record<string, unknown>;

    // The id is the whole point: without it the model cannot refer to the
    // item it just read in any follow-up call.
    expect(out.id).toBe("w-uuid");
    expect(out.ticketNumber).toBe(7);
    expect(out.status).toBe("IN_PROGRESS");
    // Default-deny is untouched — none of these are allowlisted.
    expect(JSON.stringify(out)).not.toContain("CUI title");
    expect(JSON.stringify(out)).not.toContain("the ticket body");
    expect(JSON.stringify(out)).not.toContain("Jane Doe");
  });

  it("a create/update wrapper keeps the entity it reports on", () => {
    const created = { created: true, blocker: { id: "b1", code: "BLK-9", status: "OPEN", title: "CUI", owner: "Jane Doe" } };
    const out = projectResult(created, "blocker") as Record<string, unknown>;

    expect(out.created).toBe(true);
    expect(out.blocker).toEqual({ id: "b1", code: "BLK-9", status: "OPEN" });
    expect(JSON.stringify(out)).not.toContain("Jane Doe");
  });

  it("control: a real wrapper is untouched, and its free text still drops", () => {
    // If the single-entity pass were reading SOURCE keys rather than the
    // allowlist, `query` would survive here. It must not.
    const wrapper = { query: "what the user typed", count: 1, results: [{ id: "r1", title: "CUI" }] };
    const out = projectResult(wrapper, "search_result") as Record<string, unknown>;

    expect(out.count).toBe(1);
    expect(out.query).toBeUndefined();
    expect(Array.isArray(out.results)).toBe(true);
    expect(JSON.stringify(out)).not.toContain("what the user typed");
    expect(JSON.stringify(out)).not.toContain("CUI");
  });

  it("a nested object that is NOT an entity survives only as allowlisted scalars", () => {
    // Pinned so the behaviour is chosen rather than incidental: an aggregate
    // under a wrapper key is projected through the same allowlist, so only
    // keys that happen to BE allowlisted field names can come through, and
    // only as scalars. Everything else goes.
    const withSummary = {
      count: 2,
      summary: { compliant: 3, partial: 1, narrative: "CUI prose about the control set" },
      controls: [{ id: "c1", status: "COMPLIANT" }],
    };
    const out = projectResult(withSummary, "compliance_control") as Record<string, unknown>;

    expect(out.count).toBe(2);
    expect(JSON.stringify(out)).not.toContain("CUI prose");
    // `narrative` is not an allowlisted field name, so the aggregate reduces
    // to whatever allowlisted scalars it holds — here, none.
    expect(out.summary).toEqual({});
  });

  it("an unmapped entity type is still a FULL withhold, single entity or not", () => {
    expect(projectResult({ id: "x", ticketNumber: 1 }, "no_such_entity")).toEqual({ withheld: true, ref: "withheld:structural" });
    expect(projectResult({ id: "x" }, undefined)).toEqual({ withheld: true, ref: "withheld:structural" });
  });
});
