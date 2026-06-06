import { describe, it, expect } from "vitest";
import { filterProviders, groupByCategory } from "./filter";

const sample = [
  { slug: "zoom", name: "Zoom", description: "video calls", category: "video" },
  { slug: "slack", name: "Slack", description: "team chat", category: "messaging" },
  { slug: "github", name: "GitHub", description: "code hosting", category: "dev" },
] as const;

describe("filterProviders", () => {
  it("returns all when query empty and category 'all'", () => {
    expect(filterProviders(sample as never, "", "all")).toHaveLength(3);
  });
  it("matches on name (case-insensitive)", () => {
    expect(filterProviders(sample as never, "git", "all").map((p) => p.slug)).toEqual(["github"]);
  });
  it("matches on description", () => {
    expect(filterProviders(sample as never, "chat", "all").map((p) => p.slug)).toEqual(["slack"]);
  });
  it("filters by category", () => {
    expect(filterProviders(sample as never, "", "video").map((p) => p.slug)).toEqual(["zoom"]);
  });
});

describe("groupByCategory", () => {
  it("groups providers into category buckets in CATEGORY_META order", () => {
    const groups = groupByCategory(sample as never);
    const keys = groups.map((g) => g.category);
    expect(keys).toEqual(["video", "messaging", "dev"]); // order 1,2,4
    expect(groups[0].providers.map((p) => p.slug)).toEqual(["zoom"]);
  });
});
