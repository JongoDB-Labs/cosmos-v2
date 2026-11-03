// The window parsing behind "Recent projects" (d5c10944).
//
// `?recent=` comes from a URL, so it is attacker- and typo-controlled: it has
// to map to one of the offered windows or to the default, never to NaN hours or
// an unbounded lookback.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RECENT_WINDOW,
  RECENT_WINDOWS,
  hoursForWindow,
  windowFromParam,
} from "./recent";

describe("windowFromParam", () => {
  it("accepts every window it offers", () => {
    // Positive control: if the keys and the parser ever disagree, the UI would
    // offer a button that silently selects the default.
    for (const w of RECENT_WINDOWS) {
      expect(windowFromParam(w.key)).toBe(w.key);
    }
  });

  it("falls back to the default for anything else", () => {
    for (const bad of ["", "7", "7days", "all", "-1", "99d", "DROP TABLE"]) {
      expect(windowFromParam(bad)).toBe(DEFAULT_RECENT_WINDOW);
    }
  });

  it("falls back when the param is absent", () => {
    expect(windowFromParam(undefined)).toBe(DEFAULT_RECENT_WINDOW);
  });
});

describe("hoursForWindow", () => {
  it("gives a positive, finite lookback for every window", () => {
    for (const w of RECENT_WINDOWS) {
      const h = hoursForWindow(w.key);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(0);
    }
  });

  it("orders the windows shortest to longest, as the UI shows them", () => {
    const hours = RECENT_WINDOWS.map((w) => hoursForWindow(w.key));
    expect([...hours].sort((a, b) => a - b)).toEqual(hours);
  });

  it("defaults to a window that is neither the shortest nor the longest", () => {
    // A default of "last 24 hours" shows an empty teaser after a weekend; a
    // default of "last 30 days" is barely narrower than the active list it
    // replaced.
    const hours = RECENT_WINDOWS.map((w) => hoursForWindow(w.key));
    const def = hoursForWindow(DEFAULT_RECENT_WINDOW);
    expect(def).toBeGreaterThan(Math.min(...hours));
    expect(def).toBeLessThan(Math.max(...hours));
  });
});
