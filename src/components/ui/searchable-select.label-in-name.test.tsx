// @vitest-environment jsdom
// WCAG 2.5.3 Label in Name (axe label-content-name-mismatch). A row with a
// description used to be named by an aria-label of its label, which left the
// description it shows out of the name, and the 2.1 gate flagged it. Now the
// row is named by its own content with the description hidden from the name,
// and the description still reaches assistive tech through aria-describedby.
// Both pickers render rows the same way, so both are held here.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchableSelect } from "./searchable-select";
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
  { value: "f1", label: "Ancestor", description: "Any item above this one, at any depth" },
  { value: "f2", label: "Status" },
];

const PICKERS = {
  single: () => <SearchableSelect value={null} onValueChange={() => undefined} options={OPTIONS} aria-label="Field" />,
  multi: () => <SearchableMultiSelect value={[]} onValueChange={() => undefined} options={OPTIONS} aria-label="Field" />,
};

describe.each(Object.entries(PICKERS))("%s picker: a described row's name", (_kind, Picker) => {
  it("comes from what the row shows, with the description read as a description", async () => {
    render(<Picker />);
    await userEvent.setup().click(screen.getByLabelText("Field"));
    const row = await screen.findByRole("option", { name: "Ancestor" });

    // Positive control: the row shows its description.
    expect(row).toHaveTextContent("Any item above this one, at any depth");
    // No aria-label standing in for the content it shows.
    expect(row).not.toHaveAttribute("aria-label");
    expect(row).toHaveAccessibleName("Ancestor");
    expect(row).toHaveAccessibleDescription("Any item above this one, at any depth");
  });
});
