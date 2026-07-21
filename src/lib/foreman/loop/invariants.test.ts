// @vitest-environment node
import { describe, it, expect } from "vitest";
import { enforce, type InvariantContext } from "./invariants";
import { initialState, type Action } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "C-1", title: "t", description: "", classification: "BUG", acceptanceCriteria: [] };
const ctx = (over: Partial<InvariantContext>): InvariantContext => ({
  state: initialState("id", "o", brief, 0),
  action: { kind: "run_checks" } as Action,
  ...over,
});

describe("INVARIANTS registry", () => {
  it("fails sensitive-path (with remediation) when shipping a sensitive diff", () => {
    const results = enforce(ctx({ action: { kind: "ship" }, diff: { files: ["src/lib/foreman/run.mts"], additions: 1, deletions: 0 } }));
    const sensitive = results.find((r) => r.id === "sensitive-path-review")!;
    expect(sensitive.ok).toBe(false);
    expect(sensitive.remediation).not.toBeNull();
  });
  it("passes sensitive-path when shipping a safe diff", () => {
    const results = enforce(ctx({ action: { kind: "ship" }, diff: { files: ["src/app/page.tsx"], additions: 2, deletions: 1 } }));
    expect(results.find((r) => r.id === "sensitive-path-review")!.ok).toBe(true);
  });
  it("fails changelog-required on a version bump without a changelog entry", () => {
    const results = enforce(ctx({ commit: { command: "git commit -m x", pkgVersion: "2.99.0", changelogTopVersion: "2.98.0" } }));
    expect(results.find((r) => r.id === "changelog-required")!.ok).toBe(false);
  });
  it("is a no-op (all ok) when no commit and not shipping", () => {
    expect(enforce(ctx({})).every((r) => r.ok)).toBe(true);
  });
});
