// COSMOS-81 — Sprint Dashboard drill-down.
// The dashboard's metric cards and the status/priority charts became clickable
// in v2.151.0, but the "Assignee Workload" chart stayed a dead-end: a user
// could see per-assignee ticket counts but couldn't click a bar to drill into
// that person's tickets. These tests lock the shared aggregation + drill-down
// contract so the bar a user clicks and the filtered list it opens always
// describe the SAME set of items.
import { describe, it, expect } from "vitest";
import { assigneeLabel, workloadBuckets } from "./workload";
import type { WorkItem } from "@/types/models";

const item = (assigneeId: string | null): Pick<WorkItem, "assigneeId"> => ({
  assigneeId,
});

const members = new Map<string, string>([
  ["u1", "Alice"],
  ["u2", "Bob"],
]);

describe("assigneeLabel", () => {
  it("resolves an assignee id to its member display name", () => {
    expect(assigneeLabel(item("u1"), members)).toBe("Alice");
  });

  it("returns null for unassigned items so they are excluded from workload", () => {
    expect(assigneeLabel(item(null), members)).toBeNull();
  });

  it("falls back to 'Unknown' for an assignee id with no matching member", () => {
    expect(assigneeLabel(item("ghost"), members)).toBe("Unknown");
  });
});

describe("workloadBuckets", () => {
  it("counts items per assignee, highest first, ignoring unassigned", () => {
    const items = [
      item("u1"),
      item("u1"),
      item("u1"),
      item("u2"),
      item(null), // unassigned — excluded
    ];
    expect(workloadBuckets(items, members)).toEqual([
      { name: "Alice", items: 3 },
      { name: "Bob", items: 1 },
    ]);
  });

  it("buckets unmatched assignee ids under 'Unknown'", () => {
    expect(workloadBuckets([item("ghost"), item("ghost")], members)).toEqual([
      { name: "Unknown", items: 2 },
    ]);
  });

  it("caps to the top-N assignees", () => {
    const many = new Map<string, string>();
    const bulk: Array<Pick<WorkItem, "assigneeId">> = [];
    for (let i = 0; i < 12; i++) {
      const id = `x${i}`;
      many.set(id, `User${i}`);
      // give each a distinct, ascending count so ordering is deterministic
      for (let n = 0; n <= i; n++) bulk.push(item(id));
    }
    expect(workloadBuckets(bulk, many, 3)).toHaveLength(3);
  });

  it("drill filter round-trips: each bucket's count equals the items that resolve to it", () => {
    // This is the core drill-down guarantee — clicking a bar and filtering by
    // its label must reproduce exactly the count the bar showed.
    const items = [
      item("u1"),
      item("u1"),
      item("u2"),
      item("ghost"),
      item(null),
    ];
    const buckets = workloadBuckets(items, members);
    for (const bucket of buckets) {
      const drilled = items.filter(
        (i) => assigneeLabel(i, members) === bucket.name,
      );
      expect(drilled).toHaveLength(bucket.items);
    }
  });
});
