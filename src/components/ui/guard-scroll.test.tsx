// @vitest-environment jsdom
// COSMOS-36 — right-clicking an issues-table row must not scroll ("jerk") the
// table. When the row context menu opens/closes, base-ui moves focus (a menu
// item on open, the anchor on close) and the browser scrolls the nearest
// scrollable ancestor to reveal it. `guardScroll` snapshots the scroll offsets
// and snaps them back for a short window after each open/close.
//
// The regression these tests lock: the revert must happen INSIDE the scroll
// event (capture phase), so it lands before the browser paints and the jerk is
// never visible. A frame-based-only revert lands a frame late — base-ui
// schedules its focus on rAF after this guard's, so the scrolled state paints
// for one frame first. These assert the capture-phase interceptor exists and is
// torn down when the guard is cancelled/superseded.
import { describe, it, expect, afterEach } from "vitest";
import { guardScroll } from "./action-menu";

/** A scrollable container with a child (the "anchor" descendant guardScroll is
 *  asked to protect). jsdom has no layout, so scrollTop is a plain settable
 *  number — enough to exercise the snapshot/revert logic. */
function makeScroller(): { scroller: HTMLElement; child: HTMLElement } {
  const scroller = document.createElement("div");
  // guardScroll only tracks ancestors whose computed overflow is auto/scroll.
  scroller.style.overflowY = "auto";
  const child = document.createElement("div");
  scroller.appendChild(child);
  document.body.appendChild(scroller);
  return { scroller, child };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("guardScroll (COSMOS-36 right-click scroll jerk)", () => {
  it("reverts a scroll on a tracked container synchronously during the guard window", () => {
    const { scroller, child } = makeScroller();
    scroller.scrollTop = 120; // the row's current scroll position

    guardScroll(child); // menu opens: guard the scroll from the anchor

    // base-ui focus-into-view scrolls the container, then the browser fires a
    // scroll event before painting — the guard must snap it back in that event.
    scroller.scrollTop = 400;
    scroller.dispatchEvent(new Event("scroll")); // bubbles:false, like a real scroll

    expect(scroller.scrollTop).toBe(120);
  });

  it("stops reverting once the guard is cancelled (listener removed)", () => {
    const { scroller, child } = makeScroller();
    scroller.scrollTop = 50;

    const cancel = guardScroll(child);
    cancel();

    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event("scroll"));

    expect(scroller.scrollTop).toBe(300); // no longer guarded
  });

  it("a newer guard supersedes the previous one's interceptor", () => {
    const a = makeScroller();
    a.scroller.scrollTop = 10;
    guardScroll(a.child); // guard A

    const b = makeScroller();
    b.scroller.scrollTop = 20;
    guardScroll(b.child); // guard B supersedes A

    // A is no longer guarded: a scroll on A is left alone.
    a.scroller.scrollTop = 999;
    a.scroller.dispatchEvent(new Event("scroll"));
    expect(a.scroller.scrollTop).toBe(999);

    // B is guarded: a scroll on B is snapped back to its snapshot.
    b.scroller.scrollTop = 777;
    b.scroller.dispatchEvent(new Event("scroll"));
    expect(b.scroller.scrollTop).toBe(20);
  });
});
