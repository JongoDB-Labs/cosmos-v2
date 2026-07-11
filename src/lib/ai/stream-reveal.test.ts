// @vitest-environment node
//
// COSMOS-24 regression lock: the assistant must NOT dump a coalesced network
// burst as a single render — it must reveal it incrementally (smoothly). These
// tests drive the reveal controller with a manual frame scheduler (no RAF), so
// the pacing is deterministic. A naive "set full text immediately" implementation
// would fail `reveals a burst across multiple frames` (it would produce one jump).
import { describe, it, expect } from "vitest";
import {
  createTextReveal,
  nextRevealCount,
  REVEAL_MIN_CHARS_PER_FRAME,
  type RevealScheduler,
} from "./stream-reveal";

/** A manual frame scheduler: frames run only when the test steps them. */
function makeScheduler() {
  let nextId = 1;
  const cbs = new Map<number, () => void>();
  const scheduler: RevealScheduler = {
    request(cb) {
      const id = nextId++;
      cbs.set(id, cb);
      return id;
    },
    cancel(h) {
      cbs.delete(h);
    },
  };
  return {
    scheduler,
    pending: () => cbs.size,
    /** Run the earliest scheduled frame; returns false when none are queued. */
    stepFrame() {
      const first = cbs.entries().next();
      if (first.done) return false;
      const [id, cb] = first.value;
      cbs.delete(id);
      cb();
      return true;
    },
    /** Run frames until the queue drains (bounded to avoid a runaway loop). */
    runAll(max = 5000) {
      let n = 0;
      while (this.stepFrame()) {
        if (++n >= max) break;
      }
      return n;
    },
  };
}

describe("nextRevealCount", () => {
  it("reveals nothing when caught up or ahead", () => {
    expect(nextRevealCount(0, 0)).toBe(0);
    expect(nextRevealCount(10, 10)).toBe(0);
    expect(nextRevealCount(12, 8)).toBe(0); // target shrank — never negative
  });

  it("honors the minimum chars per frame for a small backlog", () => {
    expect(nextRevealCount(0, 1)).toBe(1); // capped by remaining backlog
    expect(nextRevealCount(0, 3)).toBe(REVEAL_MIN_CHARS_PER_FRAME);
  });

  it("accelerates (ease-out) on a large backlog", () => {
    expect(nextRevealCount(0, 60)).toBe(10); // ceil(60/6)
    expect(nextRevealCount(0, 600)).toBe(100);
  });
});

describe("createTextReveal", () => {
  it("reveals a burst across multiple frames instead of one jump", () => {
    const updates: string[] = [];
    const s = makeScheduler();
    const r = createTextReveal({ onUpdate: (t) => updates.push(t), scheduler: s.scheduler });

    const target = "Hello, world! This is a fairly long streamed assistant message.";
    r.push(target); // one big coalesced burst arrives at once

    // Nothing rendered synchronously — it waits for frames.
    expect(updates.length).toBe(0);

    const frames = s.runAll();
    expect(frames).toBeGreaterThan(3); // NOT a single jump

    // Every update is a growing prefix of the target; the last equals it.
    for (const u of updates) expect(target.startsWith(u)).toBe(true);
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i].length).toBeGreaterThan(updates[i - 1].length);
    }
    expect(updates.at(-1)).toBe(target);
  });

  it("keeps pace with incremental pushes (a live token stream)", () => {
    const updates: string[] = [];
    const s = makeScheduler();
    const r = createTextReveal({ onUpdate: (t) => updates.push(t), scheduler: s.scheduler });

    let acc = "";
    for (const tok of ["The ", "quick ", "brown ", "fox ", "jumps."]) {
      acc += tok;
      r.push(acc);
      s.stepFrame(); // a frame between arrivals
    }
    r.finish(acc);
    s.runAll();

    expect(updates.at(-1)).toBe("The quick brown fox jumps.");
  });

  it("settles on finish: fires onSettled and resolves done() with the full text", async () => {
    const updates: string[] = [];
    let settledCount = 0;
    const s = makeScheduler();
    const target = "abcdefghijklmnopqrstuvwxyz0123456789";
    const r = createTextReveal({
      onUpdate: (t) => updates.push(t),
      onSettled: () => settledCount++,
      scheduler: s.scheduler,
    });

    r.push(target);
    r.finish(target);
    s.runAll();
    await r.done();

    expect(settledCount).toBe(1);
    expect(updates.at(-1)).toBe(target);
  });

  it("flush() jumps to the full target immediately and settles", async () => {
    const updates: string[] = [];
    const s = makeScheduler();
    const target = "some streamed text that has not been revealed yet";
    const r = createTextReveal({ onUpdate: (t) => updates.push(t), scheduler: s.scheduler });

    r.push(target);
    r.flush(); // e.g. a new send interrupts the tail, or a fast-path done

    expect(updates.at(-1)).toBe(target);
    expect(s.pending()).toBe(0); // the scheduled frame was cancelled
    await r.done();
  });

  it("stop() freezes at the partial text without forcing the full target", async () => {
    const updates: string[] = [];
    let settledCount = 0;
    const s = makeScheduler();
    const target = "abcdefghijklmnopqrstuvwxyz";
    const r = createTextReveal({
      onUpdate: (t) => updates.push(t),
      onSettled: () => settledCount++,
      scheduler: s.scheduler,
    });

    r.push(target);
    s.stepFrame(); // reveal a little
    const partial = updates.at(-1)!;
    expect(partial.length).toBeLessThan(target.length);

    r.stop(); // e.g. the user aborts / an error mid-stream
    expect(s.pending()).toBe(0);
    await r.done(); // still resolves

    expect(settledCount).toBe(0); // onSettled NOT called on stop
    expect(updates.at(-1)).toBe(partial); // no jump to full text
  });
});
