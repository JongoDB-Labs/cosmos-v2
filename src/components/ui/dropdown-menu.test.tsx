// @vitest-environment jsdom
// COSMOS-11 — Base UI production error #31 on the boards route.
//
// base-ui's `Menu.GroupLabel` (our `DropdownMenuLabel`) HARD-REQUIRES a
// `Menu.Group` / `Menu.RadioGroup` ancestor: it reads `MenuGroupContext` during
// render and throws production error #31 ("MenuGroupContext is missing…") the
// instant it renders without one. The Radix/shadcn pattern these components were
// ported from allowed bare labels, so a straight port crashes the whole board
// when the actions menu opens. That defect was fixed in 2.57.5 (labels wrapped
// in `DropdownMenuGroup`) but shipped without a test — so nothing stopped it
// coming back. These tests lock the contract at the primitive level.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "./dropdown-menu";

describe("DropdownMenuLabel / DropdownMenuGroup contract (Base UI #31)", () => {
  it("throws Base UI #31 when a label is rendered without a group ancestor", () => {
    // React logs the thrown render error to the console; silence it so the
    // suite output isn't noisy about the failure we're deliberately provoking.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        render(<DropdownMenuLabel>Priority</DropdownMenuLabel>),
      ).toThrow(/MenuGroupContext is missing/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("renders a labeled group and wires role=group + aria-labelledby", () => {
    render(
      <DropdownMenuGroup>
        <DropdownMenuLabel>Priority</DropdownMenuLabel>
      </DropdownMenuGroup>,
    );

    const label = screen.getByText("Priority");
    const group = screen.getByRole("group");
    // The group must point its accessible name at the label the fix restored.
    expect(label.id).toBeTruthy();
    expect(group).toHaveAttribute("aria-labelledby", label.id);
  });
});
