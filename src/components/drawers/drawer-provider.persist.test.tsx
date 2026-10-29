// @vitest-environment jsdom
//
// `setWidth` is called on every `pointermove` of a resize drag — 60-120 times a
// second — and `localStorage.setItem` is synchronous main-thread work. Writing
// on each call put a disk write in a drag's hot path, so a drag that failed to
// end kept writing for as long as the pointer moved. Persisting is debounced;
// applying the width is not.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { DrawerProvider, useDrawers } from "./drawer-provider";

function Probe() {
  const { width, setWidth } = useDrawers();
  return (
    <button onClick={() => setWidth(width + 10)} data-testid="probe">
      {width}
    </button>
  );
}

// Replace localStorage wholesale rather than spying on it: jsdom's is a Proxy,
// and vi.spyOn does not intercept calls through it — the spy records nothing
// while the real write still happens, which reads as "never written".
const setItem = vi.fn();
const real = window.localStorage;

beforeEach(() => {
  vi.useFakeTimers();
  setItem.mockReset();
  Object.defineProperty(window, "localStorage", {
    value: { setItem, getItem: () => null, removeItem: () => {}, clear: () => {} },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, "localStorage", { value: real, configurable: true });
});

describe("DrawerProvider — width persistence", () => {
  it("applies the width immediately but writes once for a burst", () => {
    render(
      <DrawerProvider>
        <Probe />
      </DrawerProvider>,
    );
    const probe = screen.getByTestId("probe");
    const before = probe.textContent;

    // A drag's worth of calls.
    act(() => {
      for (let i = 0; i < 40; i++) probe.click();
    });

    // The width moved on every call — the drag still feels live.
    expect(probe.textContent).not.toBe(before);
    // ...but nothing has been written yet, so none of those 40 calls paid for a
    // synchronous localStorage write.
    expect(setItem).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(250));
    expect(setItem).toHaveBeenCalledTimes(1);
    // And it stored the LAST value, not an early one.
    expect(setItem.mock.calls[0][1]).toBe(probe.textContent);
  });
});
