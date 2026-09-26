// COSMOS-160 — planning a sprint inside a Program Increment must start from
// that PI's work, not the whole project. These lock which intervals count as
// "in the PI" and, just as importantly, when NOTHING narrows the picker.
import { describe, it, expect } from "vitest";
import {
  assignableScopeFor,
  narrowToScope,
  type ScopeInterval,
} from "./assignable-scope";

const pi: ScopeInterval = {
  id: "pi1",
  name: "PI 1",
  intervalKind: "PROGRAM_INCREMENT",
  parentId: null,
};
const s1: ScopeInterval = { id: "s1", name: "Sprint 1", intervalKind: "SPRINT", parentId: "pi1" };
const s2: ScopeInterval = { id: "s2", name: "Sprint 2", intervalKind: "SPRINT", parentId: "pi1" };
const loose: ScopeInterval = {
  id: "s9",
  name: "Sprint 9",
  intervalKind: "SPRINT",
  parentId: null,
};
const otherPi: ScopeInterval = {
  id: "pi2",
  name: "PI 2",
  intervalKind: "PROGRAM_INCREMENT",
  parentId: null,
};
const s3: ScopeInterval = { id: "s3", name: "Sprint 3", intervalKind: "SPRINT", parentId: "pi2" };

const ALL = [pi, s1, s2, loose, otherPi, s3];

describe("assignableScopeFor", () => {
  it("scopes a sprint to its PI and that PI's sibling sprints", () => {
    const scope = assignableScopeFor(s1, ALL);
    expect(scope).not.toBeNull();
    expect(scope!.piId).toBe("pi1");
    expect(scope!.piName).toBe("PI 1");
    // The PI itself plus every sprint under it — a PI-1 story parked in Sprint
    // 2 is still PI-1's, and must stay movable into Sprint 1.
    expect([...scope!.intervalIds].sort()).toEqual(["pi1", "s1", "s2"]);
    // Another PI's sprint is never in scope.
    expect(scope!.intervalIds).not.toContain("s3");
  });

  it("does not narrow a PI's own picker — that is how work gets into the PI", () => {
    expect(assignableScopeFor(pi, ALL)).toBeNull();
  });

  it("does not narrow a standalone sprint", () => {
    expect(assignableScopeFor(loose, ALL)).toBeNull();
  });

  it("does not narrow when the parent PI is gone", () => {
    // SetNull is the schema's rule, but a stale client list can still hold a
    // dangling parentId. Filtering to a PI that no longer exists would empty
    // the picker with no visible cause.
    const orphan = { ...s1, parentId: "deleted-pi" };
    expect(assignableScopeFor(orphan, ALL)).toBeNull();
  });

  it("does not narrow when the parent is not a PI", () => {
    const nested = { ...s1, parentId: "s2" };
    expect(assignableScopeFor(nested, ALL)).toBeNull();
  });

  it("is null for no target at all", () => {
    expect(assignableScopeFor(null, ALL)).toBeNull();
  });
});

describe("narrowToScope", () => {
  const items = [
    { id: "a", intervalId: "pi1" }, // staged on the PI
    { id: "b", intervalId: "s2" }, // in a sibling sprint of the same PI
    { id: "c", intervalId: "s3" }, // another PI's sprint
    { id: "d", intervalId: null }, // backlog — never staged on the PI
  ];

  it("keeps only the PI's own items and its sprints'", () => {
    const scope = assignableScopeFor(s1, ALL);
    expect(narrowToScope(items, scope).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("is the identity when widened (null scope)", () => {
    expect(narrowToScope(items, null).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
});
