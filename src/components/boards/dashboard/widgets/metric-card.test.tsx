// @vitest-environment jsdom
// COSMOS-20 — sprint dashboard didn't render consistently across dark/light.
// Root cause: the interactive MetricCard's hover used
// `bg-[var(--muted,rgba(0,0,0,0.04))]`, but `--muted` is never defined, so the
// CSS always fell back to a hardcoded light-only black tint. On the dark
// dashboard that tint is imperceptible (and the wrong direction — dark
// surfaces should lighten on hover), so the four metric cards had no visible
// hover state in dark mode while working in light. The fix switches to the
// theme-aware `bg-muted` token (--surface, defined in both themes) that the
// sibling widgets (activity feed, drill-down list) already use.
//
// This test locks the invariant: the metric card must not reintroduce a
// hardcoded, theme-blind color literal, and its hover must use a theme token.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MetricCard } from "./metric-card";

afterEach(cleanup);

describe("MetricCard", () => {
  it("renders its label and value", () => {
    render(<MetricCard label="Total Items" value={42} />);
    expect(screen.getByText("Total Items")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("uses a theme-aware hover token (no hardcoded light-only tint) when interactive", () => {
    render(<MetricCard label="Completed" value={7} onClick={() => {}} />);
    const card = screen.getByRole("button");
    const classes = card.className;

    // The theme-aware token that works in both dark and light mode.
    expect(classes).toContain("hover:bg-muted/50");

    // Regression guard: the dark-mode bug was a hardcoded black/white tint
    // baked into the class (via an undefined CSS var's fallback). Neither a
    // literal rgb(a)/hsl(a) color nor a raw hex should appear on the card —
    // colors must flow through theme tokens so both themes stay consistent.
    expect(classes).not.toMatch(/rgba?\(/i);
    expect(classes).not.toMatch(/hsla?\(/i);
    expect(classes).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // Specifically, the old undefined-var fallback must not return.
    expect(classes).not.toContain("var(--muted");
  });

  it("is a plain, non-interactive container without onClick", () => {
    render(<MetricCard label="Overdue" value={0} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
