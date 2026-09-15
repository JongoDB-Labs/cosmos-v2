import { describe, it, expect } from "vitest";
import { isBlockingLink, blockersByItem } from "./blocking";

/**
 * The Gantt draws every dependency the same neutral grey, so "what is stuck, and
 * behind what" is invisible on a board of any size. The Blocked lens needs to
 * know two things: which EDGES represent blocking, and for a blocked item, which
 * items are doing the blocking.
 *
 * Direction is the subtlety. BLOCKS points source→target (source blocks target);
 * BLOCKED_BY points the other way. Getting that backwards draws the arrow from
 * the victim to the thing it is holding up, which is exactly wrong.
 */

const link = (id: string, type: string, sourceItemId: string, targetItemId: string) => ({
  id,
  type,
  sourceItemId,
  targetItemId,
});

describe("isBlockingLink", () => {
  it("counts BLOCKS and BLOCKED_BY", () => {
    expect(isBlockingLink("BLOCKS")).toBe(true);
    expect(isBlockingLink("BLOCKED_BY")).toBe(true);
  });

  it("ignores relationships that do not block", () => {
    // A related or duplicate link is not an impediment; colouring it red would
    // make the lens cry wolf.
    expect(isBlockingLink("RELATES_TO")).toBe(false);
    expect(isBlockingLink("DUPLICATES")).toBe(false);
    expect(isBlockingLink("")).toBe(false);
  });
});

describe("blockersByItem", () => {
  it("maps a BLOCKS link from the blocked item to its blocker", () => {
    // A BLOCKS B  ⇒  B is blocked, by A.
    const m = blockersByItem([link("l1", "BLOCKS", "A", "B")]);
    expect([...(m.get("B") ?? [])]).toEqual(["A"]);
    expect(m.has("A")).toBe(false);
  });

  it("reads BLOCKED_BY in the OTHER direction", () => {
    // A BLOCKED_BY B  ⇒  A is blocked, by B.
    const m = blockersByItem([link("l1", "BLOCKED_BY", "A", "B")]);
    expect([...(m.get("A") ?? [])]).toEqual(["B"]);
    expect(m.has("B")).toBe(false);
  });

  it("collects several blockers for one item", () => {
    const m = blockersByItem([
      link("l1", "BLOCKS", "A", "C"),
      link("l2", "BLOCKS", "B", "C"),
    ]);
    expect([...(m.get("C") ?? [])].sort()).toEqual(["A", "B"]);
  });

  it("ignores non-blocking links entirely", () => {
    expect(blockersByItem([link("l1", "RELATES_TO", "A", "B")]).size).toBe(0);
  });

  it("does not record an item as blocking itself", () => {
    // A self-link is malformed data; drawing an arrow from a bar to itself is
    // noise at best.
    expect(blockersByItem([link("l1", "BLOCKS", "A", "A")]).size).toBe(0);
  });
});
