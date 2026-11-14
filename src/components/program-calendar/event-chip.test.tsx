// @vitest-environment jsdom
//
// The kind label is sr-only, which is `position: absolute`. A chip that is not
// itself positioned lets that label be placed against the page: from a chip
// near the right edge it widened the whole document on a phone (390px wide,
// 484px of scroll). jsdom has no layout, so the measurement lives in the
// localhost drive; this pins the class that fixes it.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { EventChip } from "./event-chip";

const CATEGORY = { id: "c", name: "Sprint", tintRgb: "14 165 233", tintAlpha: 0.2, textColor: "#075985" };

afterEach(cleanup);

describe("a chip with a spoken kind", () => {
  it("is positioned, so its sr-only label stays inside it", () => {
    const { container } = render(<EventChip title="Sprint 4" category={CATEGORY} kind="sprint" />);
    const label = [...container.querySelectorAll(".sr-only")].find((n) => n.textContent === "Sprint: ");
    expect(label).toBeTruthy();
    const chip = label!.closest(".pc-chip") as HTMLElement;
    expect(chip.className.split(/\s+/)).toContain("relative");
  });
});
