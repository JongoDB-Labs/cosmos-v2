import { describe, it, expect } from "vitest";
import { satisfyingScopeSets } from "@/lib/auth/api-key-scopes";

// The spec lists every minimal scope set the gate accepts, so a client reading
// it sees that an items:write key passes a planning:write operation.
describe("satisfyingScopeSets", () => {
  it("names the contract's own set first", () => {
    expect(satisfyingScopeSets(["planning:write"])[0]).toEqual(["planning:write"]);
  });

  it("includes every scope that implies the required one", () => {
    expect(satisfyingScopeSets(["planning:write"])).toEqual([["planning:write"], ["documents:write"], ["items:write"]]);
    expect(satisfyingScopeSets(["time:read"])).toEqual([["time:read"], ["time:write"]]);
  });

  it("combines per-scope alternatives for a multi-scope operation, minimal sets only", () => {
    const sets = satisfyingScopeSets(["planning:write", "items:delete"]);
    expect(sets[0]).toEqual(["planning:write", "items:delete"]);
    expect(sets).toContainEqual(["items:delete", "items:write"]);
    for (const s of sets) expect(s).toContain("items:delete"); // nothing implies a delete
  });

  it("never lists a scope that the gate would refuse", () => {
    expect(satisfyingScopeSets(["read"]).flat()).not.toContain("rules:run");
    expect(satisfyingScopeSets(["read"]).flat()).not.toContain("members:read");
    expect(satisfyingScopeSets(["audit:read"])).toEqual([["audit:read"]]);
  });

  it("drops sets that contain a smaller one, but keeps the contract's own set first", () => {
    const sets = satisfyingScopeSets(["read", "planning:write"]);
    expect(sets[0]).toEqual(["read", "planning:write"]);
    expect(sets).toContainEqual(["planning:write"]);
    expect(sets).toContainEqual(["items:write"]);
    expect(sets).not.toContainEqual(["items:write", "read"]);
  });

  it("an operation with no scopes needs none", () => {
    expect(satisfyingScopeSets([])).toEqual([[]]);
  });
});
