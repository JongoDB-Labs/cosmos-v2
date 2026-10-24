import { describe, it, expect } from "vitest";
import { pmScopeWhere } from "./project-scope";

describe("pmScopeWhere", () => {
  it("scopes to one project", () => {
    expect(pmScopeWhere("o1", "p1")).toEqual({ orgId: "o1", projectId: "p1" });
  });

  it("scopes to a set, and an empty set matches nothing rather than everything", () => {
    expect(pmScopeWhere("o1", ["p1", "p2"])).toEqual({ orgId: "o1", projectId: { in: ["p1", "p2"] } });
    expect(pmScopeWhere("o1", [])).toEqual({ orgId: "o1", projectId: { in: [] } });
  });

  it("covers the whole org when no scope is given", () => {
    expect(pmScopeWhere("o1", undefined)).toEqual({ orgId: "o1" });
  });
});
