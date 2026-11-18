import { describe, it, expect } from "vitest";
import { judgeLockDiff } from "./lock-diff.mjs";

/**
 * A lock CHANGE has to be judgeable by whoever reviews it, with no access to
 * the private plugin repos.
 *
 * The case that matters most is "stale-version": the nightly drift sweep writes
 * plugins.lock.json through the forge's contents API, setting `.ref` and leaving
 * `.version` alone. Its rolling branch therefore moves a pin while still
 * claiming the previous release tag, and lock.mjs's own guards never run on it
 * because they live inside the generator it bypasses. The first test below is
 * that exact file, SHAs and all.
 */

// The real values, read off the base branch and the sweep's rolling branch on
// 2026-11-17.
const LOCKED_FOREMAN = "470e048843b7b4f78900ac41c223e618d0a268ed"; // v1.134.1
const HEAD_FOREMAN = "3cb9fd05aaca9d9ad8cbff766b7e170405719ece"; // v1.135.1, untagged at the time
const LOCKED_WHITEBOARD = "2971a2ff4d3a0566cb2f98bd0cc6a961edc78430"; // v0.6.0
const HEAD_WHITEBOARD = "782c4e56224dbc465ab38bbf4025fb9125f34917"; // v0.7.0
const PI = "c6b63f8cfa4cd474f5ba45469e68531e5c6e3457"; // v1.2.0, unchanged

const BASE = {
  foreman: { ref: LOCKED_FOREMAN, version: "v1.134.1" },
  "pi-planning": { ref: PI, version: "v1.2.0" },
  whiteboard: { ref: LOCKED_WHITEBOARD, version: "v0.6.0" },
};

const kinds = (list) => list.map((p) => p.kind).sort();

describe("judgeLockDiff — the sweep's own output", () => {
  // THE DEFECT. Two pins move; both annotations stay where they were.
  const SWEEP = {
    foreman: { ref: HEAD_FOREMAN, version: "v1.134.1" },
    "pi-planning": { ref: PI, version: "v1.2.0" },
    whiteboard: { ref: HEAD_WHITEBOARD, version: "v0.6.0" },
  };

  it("REFUSES a ref that moves while its version annotation stays put", () => {
    const { problems } = judgeLockDiff(BASE, SWEEP);
    expect(kinds(problems)).toEqual(["stale-version", "stale-version"]);
    expect(problems.map((p) => p.slug).sort()).toEqual(["foreman", "whiteboard"]);
  });

  it("names the stale tag and the two SHAs, so the message is actionable", () => {
    const { problems } = judgeLockDiff(BASE, SWEEP);
    const foreman = problems.find((p) => p.slug === "foreman");
    expect(foreman.message).toContain("v1.134.1");
    expect(foreman.message).toContain(LOCKED_FOREMAN.slice(0, 9));
    expect(foreman.message).toContain(HEAD_FOREMAN.slice(0, 9));
    expect(foreman.message).toContain("lock.mjs --write");
  });

  // The POSITIVE CONTROL for the test above: the same two pins, moved by
  // lock.mjs --write, which re-derives each annotation from the plugin's tags.
  // Without this, "the check fails" could just mean "the check always fails".
  it("PASSES the same two moves when the annotations move with them", () => {
    const good = {
      foreman: { ref: HEAD_FOREMAN, version: "v1.135.1" },
      "pi-planning": { ref: PI, version: "v1.2.0" },
      whiteboard: { ref: HEAD_WHITEBOARD, version: "v0.7.0" },
    };
    const { problems, notices } = judgeLockDiff(BASE, good);
    expect(problems).toEqual([]);
    expect(kinds(notices)).toEqual(["advance", "advance", "unchanged"]);
  });
});

describe("judgeLockDiff — a pin that moves backwards", () => {
  // #839 / #860 / #912: foreman from its live pin back to a far older commit,
  // proposed three times, each time reading as routine maintenance.
  it("REFUSES an annotation that moves down", () => {
    const back = { ...BASE, foreman: { ref: "5".repeat(40), version: "v1.14.1" } };
    const { problems } = judgeLockDiff(BASE, back);
    expect(kinds(problems)).toEqual(["rollback"]);
    expect(problems[0].message).toContain("v1.134.1 → v1.14.1");
    expect(problems[0].message).toContain("--allow-rollback");
  });

  it("compares numerically, not as text — v1.9.0 is not newer than v1.134.1", () => {
    const back = { ...BASE, foreman: { ref: "5".repeat(40), version: "v1.9.0" } };
    expect(kinds(judgeLockDiff(BASE, back).problems)).toEqual(["rollback"]);
  });

  it("allows a patch release as an advance", () => {
    const fwd = { ...BASE, foreman: { ref: "5".repeat(40), version: "v1.134.2" } };
    expect(judgeLockDiff(BASE, fwd).problems).toEqual([]);
  });
});

describe("judgeLockDiff — un-pinning and removal", () => {
  it("REFUSES a SHA pin replaced by 'main'", () => {
    const head = { ...BASE, whiteboard: { ref: "main" } };
    const { problems } = judgeLockDiff(BASE, head);
    expect(kinds(problems)).toEqual(["unpinned"]);
    expect(problems[0].message).toContain("reproducible");
  });

  it("keeps allowing a plugin that was ALREADY tracked at main", () => {
    const base = { ...BASE, whiteboard: { ref: "main" } };
    expect(judgeLockDiff(base, base).problems).toEqual([]);
  });

  it("REFUSES a pin that disappears", () => {
    const head = { foreman: BASE.foreman, "pi-planning": BASE["pi-planning"] };
    const { problems } = judgeLockDiff(BASE, head);
    expect(kinds(problems)).toEqual(["removed"]);
    expect(problems[0].slug).toBe("whiteboard");
    expect(problems[0].message).toContain("--prune");
  });

  it("allows the removal when the slug is no longer a public plugin", () => {
    const head = { foreman: BASE.foreman, "pi-planning": BASE["pi-planning"] };
    const { problems, notices } = judgeLockDiff(BASE, head, {
      publicPlugins: ["foreman", "pi-planning"],
    });
    expect(problems).toEqual([]);
    expect(kinds(notices)).toEqual(["removed-private", "unchanged", "unchanged"]);
  });
});

describe("judgeLockDiff — annotations without a move", () => {
  it("REFUSES a version that changes under a pin that does not", () => {
    const head = { ...BASE, foreman: { ref: LOCKED_FOREMAN, version: "v1.135.1" } };
    const { problems } = judgeLockDiff(BASE, head);
    expect(kinds(problems)).toEqual(["retagged"]);
    expect(problems[0].message).toContain("one commit cannot be two releases");
  });

  it("allows annotating a pin that was recorded before its tag existed", () => {
    const base = { ...BASE, foreman: { ref: LOCKED_FOREMAN } };
    const head = { ...BASE, foreman: { ref: LOCKED_FOREMAN, version: "v1.134.1" } };
    const { problems, notices } = judgeLockDiff(base, head);
    expect(problems).toEqual([]);
    expect(kinds(notices)).toContain("annotation-added");
  });

  it("REFUSES a version that is not a vX.Y.Z tag", () => {
    const head = { ...BASE, foreman: { ref: HEAD_FOREMAN, version: "1.135.1" } };
    expect(kinds(judgeLockDiff(BASE, head).problems)).toEqual(["version-shape"]);
  });
});

describe("judgeLockDiff — an untagged advance", () => {
  // Deliberately NOT a failure: lock.mjs --write records exactly this when the
  // plugin's HEAD is not a tagged release, and cutting the tag is a separate
  // operator step. It must be loud, because after it the file no longer names
  // what ships.
  it("allows a ref move that drops its annotation, and says so", () => {
    const head = { ...BASE, foreman: { ref: HEAD_FOREMAN } };
    const { problems, notices } = judgeLockDiff(BASE, head);
    expect(problems).toEqual([]);
    const untagged = notices.find((n) => n.kind === "untagged");
    expect(untagged.message).toContain("not a tagged release");
  });
});

describe("judgeLockDiff — a new plugin", () => {
  it("allows a slug that was not pinned before", () => {
    const base = { foreman: BASE.foreman };
    const { problems, notices } = judgeLockDiff(base, BASE);
    expect(problems).toEqual([]);
    expect(kinds(notices)).toEqual(["new", "new", "unchanged"]);
  });
});
