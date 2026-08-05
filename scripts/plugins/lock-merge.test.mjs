import { describe, it, expect } from "vitest";
import { mergeLock } from "./lock-merge.mjs";

/**
 * `lock.mjs --write` used to rebuild the lockfile from whatever plugin checkouts
 * happened to exist under plugins/. On a developer box with one plugin cloned —
 * the normal case, since each plugin is a separate private repo — it therefore
 * produced a lockfile naming one plugin and SILENTLY UNPINNING the rest, and
 * reported success while doing it.
 *
 * That is the worst shape a release-metadata bug can take: the file still parses,
 * still validates, and now says the release composes with plugins it says nothing
 * about. These pin the merge rule that prevents it.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("mergeLock", () => {
  it("records the HEAD of every plugin that is checked out", () => {
    const next = mergeLock({ alpha: SHA_A }, {});
    expect(next).toEqual({ alpha: { ref: SHA_A } });
  });

  it("updates a plugin whose checkout has moved", () => {
    const next = mergeLock({ alpha: SHA_B }, { alpha: { ref: SHA_A } });
    expect(next.alpha.ref).toBe(SHA_B);
  });

  // The whole point.
  it("KEEPS a pin whose checkout is absent instead of dropping it", () => {
    const next = mergeLock({ gamma: SHA_C }, { alpha: { ref: SHA_A }, "beta": { ref: SHA_B } });
    expect(next.alpha).toEqual({ ref: SHA_A });
    expect(next["beta"]).toEqual({ ref: SHA_B });
    expect(next.gamma).toEqual({ ref: SHA_C });
  });

  it("never silently empties the lock when no plugin is checked out at all", () => {
    const locked = { alpha: { ref: SHA_A } };
    expect(mergeLock({}, locked)).toEqual(locked);
  });

  it("drops an absent plugin only when pruning is asked for explicitly", () => {
    const next = mergeLock({ gamma: SHA_C }, { alpha: { ref: SHA_A } }, { prune: true });
    expect(next).toEqual({ gamma: { ref: SHA_C } });
  });

  it("sorts by slug so the file does not churn on checkout order", () => {
    const next = mergeLock({ gamma: SHA_C, alpha: SHA_A }, {});
    expect(Object.keys(next)).toEqual(["alpha", "gamma"]);
  });

  it("preserves a deliberate 'main' pin for an absent plugin", () => {
    // `main` is a legal ref — a plugin deliberately tracked at head. Keeping an
    // absent checkout's pin must not quietly rewrite that intent either.
    const next = mergeLock({}, { delta: { ref: "main" } });
    expect(next.delta).toEqual({ ref: "main" });
  });

  it("reports which pins it kept, so the caller can say so out loud", () => {
    const kept = [];
    mergeLock({ gamma: SHA_C }, { alpha: { ref: SHA_A } }, { onKept: (slug) => kept.push(slug) });
    expect(kept).toEqual(["alpha"]);
  });
});
