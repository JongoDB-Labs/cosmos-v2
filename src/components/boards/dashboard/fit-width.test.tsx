// @vitest-environment jsdom
//
// The dashboard grids draw at the width of the room they sit in, not a fixed
// 1200px. jsdom has no layout and no ResizeObserver, so this file supplies a
// controllable observer and drives it by hand.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { FALLBACK_GRID_WIDTH, FitWidth, useFitWidth } from "./fit-width";

type Callback = (entries: Array<{ contentRect: { width: number } }>) => void;

const observers: Array<{ cb: Callback; nodes: Element[]; disconnected: boolean }> = [];

class FakeResizeObserver {
  private record: { cb: Callback; nodes: Element[]; disconnected: boolean };
  constructor(cb: Callback) {
    this.record = { cb, nodes: [], disconnected: false };
    observers.push(this.record);
  }
  observe(node: Element) {
    this.record.nodes.push(node);
  }
  disconnect() {
    this.record.disconnected = true;
  }
  unobserve() {}
}

function resize(width: number) {
  const live = observers.filter((o) => !o.disconnected && o.nodes.length > 0);
  act(() => {
    for (const o of live) o.cb([{ contentRect: { width } }]);
  });
}

function Probe() {
  return <FitWidth>{(w) => <span data-testid="width">{w}</span>}</FitWidth>;
}

afterEach(() => {
  cleanup();
  observers.length = 0;
  vi.unstubAllGlobals();
});

describe("FitWidth", () => {
  it("draws at the measured width, and follows it as the room changes", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    render(<Probe />);
    // Positive control: before anything is measured it is the old fixed width,
    // so the server render and the first client render agree.
    expect(screen.getByTestId("width").textContent).toBe(String(FALLBACK_GRID_WIDTH));

    resize(1152);
    expect(screen.getByTestId("width").textContent).toBe("1152");
    resize(880);
    expect(screen.getByTestId("width").textContent).toBe("880");
  });

  it("ignores a zero width (a display:none wrapper) instead of drawing slivers", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    render(<Probe />);
    resize(960);
    resize(0);
    expect(screen.getByTestId("width").textContent).toBe("960");
  });

  it("starts observing a wrapper that appears AFTER mount (the skeleton-first case)", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    // The hook's owner renders a placeholder first and the wrapper only later,
    // the shape of a dashboard that paints a skeleton while it loads. A hook
    // that looked for its node once, at mount, would find nothing and never
    // measure; this pins that it starts when the node appears.
    function SkeletonFirst({ ready }: { ready: boolean }) {
      const { ref, width } = useFitWidth();
      if (!ready) return <p>loading</p>;
      return (
        <div ref={ref}>
          <span data-testid="width">{width}</span>
        </div>
      );
    }
    // `rerender` keeps the SAME component instance, so the hook's state and
    // effect carry over exactly as they would on the real page.
    const { rerender } = render(<SkeletonFirst ready={false} />);
    expect(observers.filter((o) => o.nodes.length > 0)).toHaveLength(0);
    rerender(<SkeletonFirst ready />);
    resize(1000);
    expect(screen.getByTestId("width").textContent).toBe("1000");
  });

  it("keeps the fallback where there is no ResizeObserver at all", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    render(<Probe />);
    expect(screen.getByTestId("width").textContent).toBe(String(FALLBACK_GRID_WIDTH));
  });

  it("disconnects when the grid goes away", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { unmount } = render(<Probe />);
    expect(observers[0].disconnected).toBe(false);
    unmount();
    expect(observers[0].disconnected).toBe(true);
  });
});
