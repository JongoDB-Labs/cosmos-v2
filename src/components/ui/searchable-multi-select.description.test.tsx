// @vitest-environment jsdom
// A row can carry a one-line description under its label (the assignee picker
// marks someone who can't see the project with one). The row's accessible
// NAME stays the label, so selectors and screen readers still get the name,
// and the description is attached as a description. Rows without one render
// as before.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchableMultiSelect } from "./searchable-multi-select";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || (() => {});
});

afterEach(cleanup);

const OPTIONS = [
  { value: "u1", label: "Ivy" },
  { value: "u2", label: "Otto", description: "Can't see this project" },
];

describe("SearchableMultiSelect — a row's description", () => {
  it("renders under the label, as the row's description and not part of its name", async () => {
    render(<SearchableMultiSelect value={[]} onValueChange={() => undefined} options={OPTIONS} aria-label="Assignees" />);
    await userEvent.setup().click(screen.getByLabelText("Assignees"));

    const otto = await screen.findByRole("option", { name: "Otto" });
    expect(otto).toHaveAccessibleDescription("Can't see this project");
    expect(otto).toHaveTextContent("Can't see this project");

    // Positive control on the other side: a row without one has no description.
    const ivy = screen.getByRole("option", { name: "Ivy" });
    expect(ivy).toHaveAccessibleDescription("");
    expect(ivy).not.toHaveAttribute("aria-describedby");
  });
});
