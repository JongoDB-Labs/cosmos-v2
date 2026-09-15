import { describe, it, expect, vi } from "vitest";
import { lockMoveVerdict, judgeLockMoves } from "./lock-direction.mjs";

/**
 * A plugin pin must only ever move FORWARD.
 *
 * Twice in production (#839, #860) a lock bump proposed moving the foreman pin
 * from the deployed commit back to one of its ancestors — 174 commits of daemon
 * work, including the fix for a spin that OOM'd it. Both PRs looked like routine
 * maintenance: the diff is two SHAs, the log line reads `a → b`, and the title
 * reports a version string, which cannot tell you which way you are travelling.
 *
 * These pin the rule. The case that matters most is `unknown` — see the comment
 * on that test.
 */

const OLD = "e7e2772639c7349dd0e7bc61dc515242e3e62e0f"; // the live pin, VERSION 1.96.0
const ANCESTOR = "54561548f2c6eb27ffffa17251a5346b1ecf5c8a"; // VERSION 1.14.1, 174 behind
const NEWER = "f".repeat(40);
const OTHER = "1".repeat(40);

describe("lockMoveVerdict", () => {
  it("passes a pin that moves to a descendant — the only good case", () => {
    const v = lockMoveVerdict({ slug: "foreman", from: OLD, to: NEWER, ancestry: "advance" });
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("advance");
  });

  // THE DEFECT, with the real SHAs from #860.
  it("REFUSES a pin that moves to an ancestor", () => {
    const v = lockMoveVerdict({ slug: "foreman", from: OLD, to: ANCESTOR, ancestry: "rollback" });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("rollback");
    // The message has to say the direction out loud, because "e7e2772 → 5456154"
    // read as progress is exactly how this shipped twice.
    expect(v.message).toContain("ROLLS THE PIN BACK");
    expect(v.message).toContain("ancestor");
    // ...and name the way out, so refusing does not just block a real revert.
    expect(v.message).toContain("--allow-rollback");
  });

  /**
   * The case that actually fires in the wild, and the one a guard written in
   * haste gets wrong.
   *
   * A checkout stale enough to roll the pin back is usually stale enough not to
   * CONTAIN the pin it replaces — it was cloned before that commit existed. If
   * "I cannot tell" were treated as "probably fine", the guard would wave
   * through the most common form of the very defect it was built for.
   */
  it("REFUSES a move it cannot verify, rather than assuming it is fine", () => {
    const v = lockMoveVerdict({ slug: "foreman", from: OLD, to: ANCESTOR, ancestry: "unknown" });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("unknown");
    expect(v.message).toContain("cannot verify");
    expect(v.message).toContain("fetch");
  });

  it("REFUSES a move to a commit with no shared ancestry", () => {
    const v = lockMoveVerdict({ slug: "foreman", from: OLD, to: OTHER, ancestry: "diverged" });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("diverged");
  });

  it("treats a missing ancestry as unverified, not as permission", () => {
    // Defensive: a caller that forgets to compute ancestry must not get a pass.
    const v = lockMoveVerdict({ slug: "foreman", from: OLD, to: ANCESTOR });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("unknown");
  });

  it("passes a newly pinned plugin — there is nothing to move backwards from", () => {
    const v = lockMoveVerdict({ slug: "whiteboard", from: undefined, to: NEWER });
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("new");
  });

  it("passes a plugin deliberately tracked at main", () => {
    // `main` means "whatever is there"; there is no commit to protect, and
    // REF_RE admits it precisely so that choice stays available.
    const v = lockMoveVerdict({ slug: "pi-planning", from: "main", to: ANCESTOR });
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("tracking");
  });

  it("passes an unchanged pin", () => {
    const v = lockMoveVerdict({ slug: "foreman", from: OLD, to: OLD });
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("unchanged");
  });

  it("names the plugin in every verdict, so a multi-plugin failure says which", () => {
    for (const ancestry of ["advance", "rollback", "diverged", "unknown"]) {
      const v = lockMoveVerdict({ slug: "foreman", from: OLD, to: NEWER, ancestry });
      expect(v.slug).toBe("foreman");
      expect(v.message.startsWith("foreman:")).toBe(true);
    }
  });
});

describe("judgeLockMoves", () => {
  const ancestryAlways = (kind) => vi.fn(() => kind);

  it("collects the failures and nothing else", () => {
    const next = { alpha: { ref: NEWER }, foreman: { ref: ANCESTOR } };
    const locked = { alpha: { ref: OLD }, foreman: { ref: OLD } };
    const ancestryOf = vi.fn((slug) => (slug === "foreman" ? "rollback" : "advance"));

    const { verdicts, problems } = judgeLockMoves(next, locked, ancestryOf);

    expect(verdicts).toHaveLength(2);
    expect(problems).toHaveLength(1);
    expect(problems[0].slug).toBe("foreman");
  });

  it("reports no problems when every pin advances", () => {
    // ANTI-VACUITY partner to the test above: the guard must be capable of
    // saying yes, or "problems is empty" proves nothing when it is.
    const { problems } = judgeLockMoves(
      { alpha: { ref: NEWER } },
      { alpha: { ref: OLD } },
      ancestryAlways("advance"),
    );
    expect(problems).toEqual([]);
  });

  /**
   * mergeLock() carries a pin over untouched when a plugin has no checkout —
   * the normal case, since each plugin is its own private repo. Asking git about
   * that pin would mean shelling into a directory that is not there.
   */
  it("never consults git for a pin that did not move", () => {
    const ancestryOf = vi.fn(() => "rollback");
    const { problems } = judgeLockMoves(
      { alpha: { ref: OLD } },
      { alpha: { ref: OLD } },
      ancestryOf,
    );
    expect(ancestryOf).not.toHaveBeenCalled();
    expect(problems).toEqual([]);
  });

  it("never consults git for a plugin pinned to main", () => {
    const ancestryOf = vi.fn(() => "rollback");
    judgeLockMoves({ alpha: { ref: NEWER } }, { alpha: { ref: "main" } }, ancestryOf);
    expect(ancestryOf).not.toHaveBeenCalled();
  });

  it("judges the map about to be WRITTEN, against the lock on disk", () => {
    // The guard has to see the same refs that get persisted. Handing it the
    // discovered heads instead would miss anything mergeLock() decided.
    const ancestryOf = vi.fn(() => "advance");
    judgeLockMoves({ foreman: { ref: NEWER } }, { foreman: { ref: OLD } }, ancestryOf);
    expect(ancestryOf).toHaveBeenCalledWith("foreman", OLD, NEWER);
  });
});
