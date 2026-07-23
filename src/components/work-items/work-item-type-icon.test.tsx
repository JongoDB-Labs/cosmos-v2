// @vitest-environment jsdom
// COSMOS-90 — work-item types store their glyph as a lucide icon *name* (e.g.
// "BookOpen", "Flag", "Milestone"; see prisma/seed/sectors/*). Surfaces that
// showed a type were printing that raw string instead of resolving it, so the
// Issues list rendered literal text like "BookOpen Story" in place of the SVG.
// This locks the resolver: known names render an <svg>, unknown/custom names
// fall back to a glyph too, and the raw name never leaks as visible text.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WorkItemTypeIcon, resolveWorkItemTypeIcon } from "./work-item-type-icon";

afterEach(cleanup);

describe("WorkItemTypeIcon (COSMOS-90)", () => {
  it("renders a known icon name as an <svg>, not the raw string", () => {
    const { container } = render(<WorkItemTypeIcon icon="BookOpen" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    // The stored name must never surface as visible text.
    expect(screen.queryByText("BookOpen")).not.toBeInTheDocument();
  });

  it("falls back to a glyph for an unknown/custom name (still an svg, no text)", () => {
    const { container } = render(<WorkItemTypeIcon icon="TotallyMadeUpIcon" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByText("TotallyMadeUpIcon")).not.toBeInTheDocument();
  });

  it("renders a fallback glyph when icon is null", () => {
    const { container } = render(<WorkItemTypeIcon icon={null} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("applies the type color to the glyph when provided", () => {
    const { container } = render(<WorkItemTypeIcon icon="Flag" color="#ff0000" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveStyle({ color: "#ff0000" });
  });

  it("resolveWorkItemTypeIcon returns a component for both known and unknown names", () => {
    // Known name resolves to a distinct component; unknown/null fall back —
    // never undefined, so a call site can always render an <svg>.
    expect(resolveWorkItemTypeIcon("Milestone")).toBeTruthy();
    expect(resolveWorkItemTypeIcon("nope")).toBeTruthy();
    expect(resolveWorkItemTypeIcon(null)).toBeTruthy();
    expect(resolveWorkItemTypeIcon("Flag")).not.toBe(resolveWorkItemTypeIcon("Milestone"));
  });
});
