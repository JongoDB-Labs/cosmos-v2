// src/lib/ai/stream-deltas.test.ts
//
// COSMOS-24. The tracker's whole job is surviving the loop's PER-TURN cumulative
// buffer: a tool-using run streams a preamble in one turn and the answer in the
// next, each restarting from "". A non-turn-aware offset drops the head of the
// second turn and then dumps the rest in one chunk.
import { describe, it, expect } from "vitest";

import { createDeltaTracker, summarizeStreamTiming } from "./stream-deltas";

describe("createDeltaTracker", () => {
  it("forwards one delta per update within a single turn", () => {
    const t = createDeltaTracker();
    expect(t.next("You ")).toBe("You ");
    expect(t.next("You have ")).toBe("have ");
    expect(t.next("You have two projects.")).toBe("two projects.");
    expect(t.sent()).toBe("You have two projects.");
  });

  it("restarts the offset when a new turn's cumulative buffer begins", () => {
    const t = createDeltaTracker();
    // Turn 0 — the tool-use preamble.
    t.next("Let me ");
    t.next("Let me look that up.");
    // Turn 1 — the real answer, cumulative from "" again. Every one of these is
    // SHORTER than the preamble; a single running offset would drop them all.
    expect(t.next("You ")).toBe("You ");
    expect(t.next("You have ")).toBe("have ");
    expect(t.next("You have two projects.")).toBe("two projects.");
    expect(t.sent()).toBe("Let me look that up.You have two projects.");
  });

  it("returns nothing for a repeated or shorter update within a turn", () => {
    const t = createDeltaTracker();
    t.next("Hello world");
    expect(t.next("Hello world")).toBe("");
    expect(t.sent()).toBe("Hello world");
  });

  it("yields the whole final text when nothing streamed for that turn", () => {
    const t = createDeltaTracker();
    t.next("Working on it.");
    // A tool-only run: the final text never arrived as deltas.
    expect(t.next("I applied 2 actions.")).toBe("I applied 2 actions.");
  });

  it("yields nothing when the final text was already fully streamed", () => {
    const t = createDeltaTracker();
    t.next("Done.");
    expect(t.next("Done.")).toBe("");
  });
});

describe("summarizeStreamTiming", () => {
  it("reports ttft, delta count and the gap distribution", () => {
    const timing = summarizeStreamTiming(1_000, [1_120, 1_140, 1_200], 42);
    expect(timing).toEqual({
      ttftMs: 120,
      deltas: 3,
      chars: 42,
      meanGapMs: 40, // (20 + 60) / 2
      maxGapMs: 60,
    });
  });

  it("nulls the gap stats when there is at most one delta", () => {
    expect(summarizeStreamTiming(1_000, [1_050], 5)).toEqual({
      ttftMs: 50,
      deltas: 1,
      chars: 5,
      meanGapMs: null,
      maxGapMs: null,
    });
    expect(summarizeStreamTiming(1_000, [], 0)).toEqual({
      ttftMs: null,
      deltas: 0,
      chars: 0,
      meanGapMs: null,
      maxGapMs: null,
    });
  });
});
