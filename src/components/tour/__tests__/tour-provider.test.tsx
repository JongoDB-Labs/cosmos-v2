// Resume, clamping, and surviving a storage layer that lies.
//
// The failure that matters is not a wrong step number — it is the page not
// rendering because JSON.parse threw on something an older version wrote, or a
// private window refused to answer.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TourProvider, useTour } from "../tour-provider";
import type { Tour } from "@/lib/tours/types";

const TOUR: Tour = {
  id: "test-tour",
  name: "Test",
  summary: "",
  released: "2026-01-01",
  steps: [
    { id: "a", title: "A", blurb: "", look: "" },
    { id: "b", title: "B", blurb: "", look: "" },
    { id: "c", title: "C", blurb: "", look: "" },
  ],
};

function Harness({ at }: { at?: number }) {
  const { tour, index, start, next, back, stop } = useTour();
  return (
    <div>
      <span data-testid="state">{tour ? tour.id + ":" + index : "idle"}</span>
      <button onClick={() => start(TOUR, at)}>start</button>
      <button onClick={next}>next</button>
      <button onClick={back}>back</button>
      <button onClick={stop}>stop</button>
    </div>
  );
}

const state = () => screen.getByTestId("state").textContent;
const click = (label: string) => fireEvent.click(screen.getByText(label));

beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

describe("stepping", () => {
  it("starts at the first step and advances", () => {
    render(<TourProvider><Harness /></TourProvider>);
    expect(state()).toBe("idle");
    click("start");
    expect(state()).toBe("test-tour:0");
    click("next");
    expect(state()).toBe("test-tour:1");
    click("back");
    expect(state()).toBe("test-tour:0");
  });

  it("clamps at both ends rather than running off the tour", () => {
    render(<TourProvider><Harness /></TourProvider>);
    click("start");
    click("back");
    expect(state()).toBe("test-tour:0");
    click("next"); click("next"); click("next"); click("next");
    expect(state()).toBe("test-tour:2");
  });

  it("stop leaves the tour, and nothing renders for it", () => {
    render(<TourProvider><Harness /></TourProvider>);
    click("start"); click("stop");
    expect(state()).toBe("idle");
  });
});

describe("resume", () => {
  it("comes back to where they stopped", () => {
    const { unmount } = render(<TourProvider><Harness /></TourProvider>);
    click("start"); click("next"); click("next");
    expect(state()).toBe("test-tour:2");
    unmount();
    render(<TourProvider><Harness /></TourProvider>);
    click("start");
    expect(state()).toBe("test-tour:2");
  });

  it("an explicit step wins over the remembered one", () => {
    render(<TourProvider><Harness /></TourProvider>);
    click("start"); click("next");
    // "Walk me through it" always restarts from the top, whatever was remembered.
    render(<TourProvider><Harness at={0} /></TourProvider>);
    const starts = screen.getAllByText("start");
    fireEvent.click(starts[starts.length - 1]);
    const states = screen.getAllByTestId("state");
    expect(states[states.length - 1].textContent).toBe("test-tour:0");
  });

  it("clamps a remembered step that is past the end of a shortened tour", () => {
    window.localStorage.setItem("cosmos:tour-progress", JSON.stringify({ "test-tour": 99 }));
    render(<TourProvider><Harness /></TourProvider>);
    click("start");
    expect(state()).toBe("test-tour:2");
  });
});

describe("storage that lies", () => {
  it("starts from the beginning when the stored value is not JSON", () => {
    window.localStorage.setItem("cosmos:tour-progress", "{not json");
    render(<TourProvider><Harness /></TourProvider>);
    expect(() => click("start")).not.toThrow();
    expect(state()).toBe("test-tour:0");
  });

  it("starts from the beginning when the stored shape is wrong", () => {
    window.localStorage.setItem("cosmos:tour-progress", JSON.stringify({ "test-tour": "two" }));
    render(<TourProvider><Harness /></TourProvider>);
    click("start");
    expect(state()).toBe("test-tour:0");
  });

  it("keeps working when storage throws on read and on write", () => {
    // A private window, or site data blocked. The tour is a convenience; it must
    // not take the page down with it.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<TourProvider><Harness /></TourProvider>);
    expect(() => { click("start"); click("next"); }).not.toThrow();
    expect(state()).toBe("test-tour:1");
  });
});

describe("without a provider", () => {
  it("renders, and does nothing", () => {
    render(<Harness />);
    expect(state()).toBe("idle");
    expect(() => click("start")).not.toThrow();
    expect(state()).toBe("idle");
  });
});
