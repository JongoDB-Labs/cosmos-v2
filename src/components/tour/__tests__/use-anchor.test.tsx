// Finding the element a step points at.
//
// The failure that matters is not "no highlight" — it is a highlight in the
// WRONG place, or a card pointing confidently at nothing. Pages load their data
// after mount, so the element a step is about is routinely absent for the first
// second and must simply be treated as absent until it is not.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useAnchor, scrollAnchorIntoView } from "../use-anchor";

function Probe({ anchor }: { anchor?: string }) {
  const box = useAnchor(anchor);
  return <span data-testid="box">{box ? `${box.width}x${box.height}` : "none"}</span>;
}

const read = () => screen.getByTestId("box").textContent;

/** jsdom gives every element a zero rect, so the size has to be supplied. */
function sized(el: HTMLElement, w: number, h: number) {
  el.getBoundingClientRect = () =>
    ({ top: 10, left: 20, width: w, height: h, right: 20 + w, bottom: 10 + h, x: 20, y: 10, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("finding the element", () => {
  it("measures an element carrying the matching data-tour", () => {
    const el = document.createElement("div");
    el.setAttribute("data-tour", "panel-a");
    sized(el, 300, 120);
    document.body.appendChild(el);
    render(<Probe anchor="panel-a" />);
    expect(read()).toBe("300x120");
  });

  it("reports nothing when no element matches", () => {
    render(<Probe anchor="not-on-this-page" />);
    expect(read()).toBe("none");
  });

  it("reports nothing when the step names no anchor", () => {
    const el = document.createElement("div");
    el.setAttribute("data-tour", "panel-a");
    sized(el, 300, 120);
    document.body.appendChild(el);
    render(<Probe />);
    expect(read()).toBe("none");
  });
});

describe("elements that are present but not ready", () => {
  it("treats a zero-sized element as absent rather than drawing a dot", () => {
    // Collapsed, or rendered before layout. A 0x0 ring reads as a rendering bug.
    const el = document.createElement("div");
    el.setAttribute("data-tour", "panel-a");
    sized(el, 0, 0);
    document.body.appendChild(el);
    render(<Probe anchor="panel-a" />);
    expect(read()).toBe("none");
  });

  it("picks the element up once it appears", async () => {
    // The common case: the page fetches, then renders the panel.
    render(<Probe anchor="late" />);
    expect(read()).toBe("none");
    await act(async () => {
      const el = document.createElement("div");
      el.setAttribute("data-tour", "late");
      sized(el, 200, 80);
      document.body.appendChild(el);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(read()).toBe("200x80");
  });
});

describe("when the element goes away", () => {
  it("stops reporting a box, so no ring is left pointing at nothing", async () => {
    // Navigating between steps, or a panel collapsing, removes the element. A
    // box kept from the last measurement leaves a highlight ringing empty space
    // — worse than never having highlighted at all.
    const el = document.createElement("div");
    el.setAttribute("data-tour", "goes-away");
    sized(el, 120, 40);
    document.body.appendChild(el);
    render(<Probe anchor="goes-away" />);
    expect(read()).toBe("120x40");

    await act(async () => {
      el.remove();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(read()).toBe("none");
  });
});

describe("anchors with awkward names", () => {
  it("does not break on a value needing escaping", () => {
    // CSS.escape matters: an unescaped quote would throw inside querySelector
    // and take the whole card down with it.
    const el = document.createElement("div");
    el.setAttribute("data-tour", 'odd"name');
    sized(el, 50, 50);
    document.body.appendChild(el);
    expect(() => render(<Probe anchor={'odd"name'} />)).not.toThrow();
  });
});

// A step that changes page has NO anchor to find at the moment it becomes
// current — the route is still loading, and on this app that takes seconds.
// A single attempt found nothing, scrolled nothing, and said nothing: the
// reader landed on a page with the ring somewhere off screen. That was every
// step in a walkthrough that moves between pages.
describe("scrollAnchorIntoView waits for the page it is aiming at", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });
  afterEach(() => vi.useRealTimers());

  const plant = (name: string) => {
    const el = document.createElement("div");
    el.setAttribute("data-tour", name);
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    return el;
  };

  it("scrolls as soon as the element exists", () => {
    const el = plant("late");
    scrollAnchorIntoView("late");
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("keeps looking while the route is still rendering", () => {
    scrollAnchorIntoView("late");
    vi.advanceTimersByTime(1000); // nothing there yet
    const el = plant("late");
    vi.advanceTimersByTime(400);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("scrolls only once, not on every poll", () => {
    scrollAnchorIntoView("late");
    vi.advanceTimersByTime(600);
    const el = plant("late");
    vi.advanceTimersByTime(3000);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("stops when cancelled, so stepping on does not drag the reader back", () => {
    const cancel = scrollAnchorIntoView("late");
    vi.advanceTimersByTime(400);
    cancel();
    const el = plant("late");
    vi.advanceTimersByTime(3000);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it("gives up rather than polling for ever", () => {
    scrollAnchorIntoView("never");
    vi.advanceTimersByTime(30_000);
    const el = plant("never");
    vi.advanceTimersByTime(5_000);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });
});
